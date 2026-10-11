import Foundation

struct GitShowInput {
    private struct Arguments {
        let ref: String
        let detail: String
        let contextLines: Int
        let detectRenames: Bool
    }

    private struct Outputs {
        let detail: String
        let metadata: VCSCommitInfo
        let numstat: String
        let nameStatus: String
        let patch: String?
    }

    private enum Work {
        case arguments(Arguments)
        case metadata(Data)
        case projection(Outputs)
    }

    private let work: Work

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any], let kind = raw["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        if kind == "prepareGitShow" {
            let fields = try WireObject(value, keys: ["kind", "ref", "detail", "contextLines", "detectRenames"])
            work = try .arguments(Arguments(
                ref: fields.string("ref").trimmingCharacters(in: .whitespacesAndNewlines),
                detail: fields.string("detail"), contextLines: fields.integer("contextLines"),
                detectRenames: fields.boolean("detectRenames")
            ))
        } else if kind == "parseGitShowMetadata" {
            let fields = try WireObject(value, keys: ["kind", "bytes"])
            work = try .metadata(fields.bytes("bytes"))
        } else {
            let fields = try WireObject(value, keys: ["kind", "detail", "metadata", "numstat", "nameStatus", "patch"])
            func text(_ name: String) throws -> String {
                guard let text = try String(data: fields.bytes(name), encoding: .utf8) else {
                    throw BridgeFailure("gitOutputUndecodable")
                }
                return text
            }
            let record = try WireObject(
                fields.value("metadata"), keys: ["id", "shortID", "author", "dateISO", "message"]
            )
            let commit = try VCSCommitInfo(id: record.string("id"), shortID: record.string("shortID"),
                                           author: record.string("author"), dateISO: record.string("dateISO"),
                                           message: record.string("message"))
            work = try .projection(Outputs(
                detail: fields.string("detail"), metadata: commit, numstat: text("numstat"),
                nameStatus: text("nameStatus"), patch: fields.value("patch") is NSNull ? nil : text("patch")
            ))
        }
    }

    func render() throws -> [String: Any] {
        switch work {
        case let .arguments(input):
            guard !input.ref.isEmpty else {
                return ["kind": "gitShowError", "message": "ref is required for op: show"]
            }
            let show = RPCEGitShow()
            let detail = Self.detail(input.detail)
            let patch: Any = detail == "full"
                ? show.diffArguments(kind: nil, contextLines: input.contextLines, detectRenames: input.detectRenames)
                : NSNull()
            return ["kind": "gitShowArguments", "ref": input.ref, "metadata": show.metadataArguments(),
                    "numstat": show.diffArguments(
                        kind: "--numstat", contextLines: nil, detectRenames: input.detectRenames
                    ),
                    "nameStatus": show.diffArguments(
                        kind: "--name-status", contextLines: nil, detectRenames: input.detectRenames
                    ),
                    "patch": patch]
        case let .metadata(bytes):
            guard let text = String(data: bytes, encoding: .utf8) else { throw BridgeFailure("gitOutputUndecodable") }
            do {
                let info = try RPCEGitShow().parseMetadata(text)
                let commit = ["id": info.sha, "shortID": info.shortSHA, "author": info.author,
                              "dateISO": info.dateISO, "message": info.message]
                return ["kind": "gitShowMetadata", "commit": commit]
            } catch let error as RPCEGitShowError {
                return ["kind": "gitShowError", "message": error.message]
            }
        case let .projection(input):
            let files = RPCEGitDiffStats().parse(numstat: input.numstat, nameStatus: input.nameStatus)
            let show = RPCEGitProjection.makeShowDTO(
                commitInfo: input.metadata, changedFiles: files,
                detail: Self.detail(input.detail), diffText: input.patch
            )
            let bytes = try JSONEncoder().encode(show)
            return try ["kind": "gitShow", "show": decodeWireJSON(bytes)]
        }
    }

    private static func detail(_ raw: String) -> String {
        let detail = raw.lowercased()
        return detail == "patches" ? "full" : detail
    }
}
