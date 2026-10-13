import Foundation

struct GitDiffAcquisitionInput {
    private struct Arguments {
        let compare: GitDiffCompareSpec
        let paths: [String]
        let root: String
        let contextLines: Int
        let detectRenames: Bool
    }

    private struct Untracked {
        let path: String
        let bytes: Data?
    }

    private enum Work {
        case arguments(Arguments)
        case statistics(String, String, [Untracked])
        case untrackedPatch(String)
    }

    private let work: Work

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any], let kind = raw["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        if kind == "prepareGitDiff" {
            let fields = try WireObject(value, keys: [
                "kind", "compare", "paths", "repoRootPath", "contextLines", "detectRenames"
            ])
            guard let paths = try fields.value("paths") as? [String] else {
                throw BridgeFailure("nativeProtocolError")
            }
            let comparison = try fields.value("compare")
            let compare: GitDiffCompareSpec
            if let raw = comparison as? String {
                compare = GitDiffCompareSpec.parse(raw)
            } else {
                compare = try JSONDecoder().decode(GitDiffCompareSpec.self,
                                                  from: JSONSerialization.data(withJSONObject: comparison))
            }
            work = try .arguments(Arguments(compare: compare, paths: paths,
                                            root: fields.string("repoRootPath"),
                                            contextLines: fields.integer("contextLines"),
                                            detectRenames: fields.boolean("detectRenames")))
        } else if kind == "normalizeGitUntrackedPatch" {
            let fields = try WireObject(value, keys: ["kind", "text"])
            work = try .untrackedPatch(fields.string("text"))
        } else {
            let fields = try WireObject(value, keys: ["kind", "numstat", "nameStatus", "untracked"])
            guard let numstat = try String(data: fields.bytes("numstat"), encoding: .utf8),
                  let nameStatus = try String(data: fields.bytes("nameStatus"), encoding: .utf8),
                  let values = try fields.value("untracked") as? [Any]
            else { throw BridgeFailure("gitOutputUndecodable") }
            let untracked = try values.map { value in
                let row = try WireObject(value, keys: ["path", "bytes"])
                return try Untracked(
                    path: row.string("path"),
                    bytes: row.value("bytes") is NSNull ? nil : row.bytes("bytes")
                )
            }
            work = .statistics(numstat, nameStatus, untracked)
        }
    }

    func render() throws -> [String: Any] {
        switch work {
        case let .untrackedPatch(text):
            return ["kind": "gitUntrackedPatch", "text": RPCEGitDiffCommands.normalizeBatchedUntrackedDiffPaths(text)]
        case let .arguments(input):
            let compare = input.compare
            let paths = input.paths.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            let commands = RPCEGitDiffCommands().arguments(
                compare: compare, contextLines: input.contextLines, detectRenames: input.detectRenames
            )
            let includeUntracked = switch compare {
            case .uncommitted, .uncommittedMergeBase, .unstaged: true
            case .staged, .stagedMergeBase, .revspec: false
            }
            return try ["kind": "gitDiffArguments", "comparison": decodeWireJSON(JSONEncoder().encode(compare)),
                        "display": compare.displayString, "rawKey": compare.rawKey, "inputCount": paths.count,
                        "hasRelativeInputs": paths.contains { !(($0 as NSString).expandingTildeInPath).hasPrefix("/") },
                        "paths": GitDiffPathNormalization.gitPathspecs(from: paths, repoRootPath: input.root),
                        "pathspecs": GitDiffPathNormalization.gitDiscoveryPathspecs(
                            from: paths,
                            repoRootPath: input.root
                        ),
                        "includeUntracked": includeUntracked, "numstat": commands.numstat,
                        "nameStatus": commands.nameStatus, "patch": commands.patch]
        case let .statistics(numstat, nameStatus, untracked):
            var files = RPCEGitDiffStats().parse(numstat: numstat, nameStatus: nameStatus)
            let trackedPaths = Set(files.map(\.path))
            for entry in untracked where !trackedPaths.contains(entry.path) {
                let counts = Self.untrackedLineStats(entry.bytes)
                files.append(VCSUncommittedFile(
                    path: entry.path,
                    status: "??",
                    additions: counts.0,
                    deletions: counts.1
                ))
            }
            let keyed = files.map { file in
                (lower: file.path.lowercased(), original: file.path, file: file)
            }
            let sorted = keyed.sorted { lhs, rhs in
                if lhs.lower != rhs.lower { return lhs.lower < rhs.lower }
                return lhs.original < rhs.original
            }.map(\.file)
            return ["kind": "gitDiffStats", "files": sorted.map { file in
                ["path": file.path, "status": file.status, "additions": file.additions as Any? ?? NSNull(),
                 "deletions": file.deletions as Any? ?? NSNull()]
            }]
        }
    }

    /// GitService.untrackedLineStats counts raw LF bytes and treats NUL-containing input as binary.
    private static func untrackedLineStats(_ data: Data?) -> (Int?, Int?) {
        guard let data else { return (nil, nil) }
        var lineCount = 0
        let isText = data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for byte in bytes {
                if byte == 0 { return false }
                if byte == 0x0A { lineCount += 1 }
            }
            return true
        }
        guard isText else { return (nil, nil) }
        if let lastByte = data.last, lastByte != 0x0A { lineCount += 1 }
        return (lineCount, 0)
    }
}
