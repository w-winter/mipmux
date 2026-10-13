import Foundation

struct GitDiffInput {
    private struct Projection {
        let compare: String
        let detail: String
        let pathspecCount: Int
        let isMultiRepo: Bool
        let changedFiles: [VCSUncommittedFile]
        let perFilePatches: [String: String]?
    }

    private enum Work {
        case comparison(String?)
        case paths([String], String)
        case projection(Projection)
    }

    private let work: Work
    private static let patchLineLimit = 300

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any], let kind = raw["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        if kind == "parseGitComparison" {
            let fields = try WireObject(value, keys: ["kind", "raw"])
            work = try .comparison(fields.value("raw") is NSNull ? nil : fields.string("raw"))
        } else if kind == "normalizeGitDiffPaths" {
            let fields = try WireObject(value, keys: ["kind", "paths", "repoRootPath"])
            guard let paths = try fields.value("paths") as? [String] else {
                throw BridgeFailure("nativeProtocolError")
            }
            work = try .paths(paths, fields.string("repoRootPath"))
        } else {
            let fields = try WireObject(value, keys: [
                "kind", "compare", "detail", "pathspecCount", "isMultiRepo", "changedFiles", "perFilePatches"
            ])
            guard let values = try fields.value("changedFiles") as? [Any] else {
                throw BridgeFailure("nativeProtocolError")
            }
            let files = try values.map { value in
                let row = try WireObject(value, keys: ["path", "status", "additions", "deletions"])
                return try VCSUncommittedFile(
                    path: row.string("path"), status: row.string("status"),
                    additions: row.value("additions") is NSNull ? nil : row.integer("additions"),
                    deletions: row.value("deletions") is NSNull ? nil : row.integer("deletions")
                )
            }
            let patchesValue = try fields.value("perFilePatches")
            let patches: [String: String]?
            if patchesValue is NSNull {
                patches = nil
            } else {
                guard let dictionary = patchesValue as? [String: String] else {
                    throw BridgeFailure("nativeProtocolError")
                }
                patches = dictionary
            }
            work = try .projection(Projection(
                compare: fields.string("compare"), detail: fields.string("detail").lowercased(),
                pathspecCount: fields.count("pathspecCount"), isMultiRepo: fields.boolean("isMultiRepo"),
                changedFiles: files, perFilePatches: patches
            ))
        }
    }

    func render() throws -> [String: Any] {
        switch work {
        case let .comparison(raw):
            let comparison = GitDiffCompareSpec.parse(raw)
            let bytes = try JSONEncoder().encode(comparison)
            return try ["kind": "gitComparison", "comparison": decodeWireJSON(bytes),
                        "rawKey": comparison.rawKey, "display": comparison.displayString]
        case let .paths(paths, root):
            return ["kind": "gitDiffPaths",
                    "paths": GitDiffPathNormalization.gitPathspecs(from: paths, repoRootPath: root),
                    "pathspecs": GitDiffPathNormalization.gitDiscoveryPathspecs(from: paths, repoRootPath: root)]
        case let .projection(input):
            let effectiveDetail: String = if input.pathspecCount == 1, input.detail == "summary", !input.isMultiRepo {
                "patches"
            } else {
                input.detail
            }
            let maxLinesForPatches = effectiveDetail == "full" ? Int.max : Self.patchLineLimit
            let diff = RPCEGitProjection.makeDiffDTO(
                compare: input.compare, detail: effectiveDetail, changedFiles: input.changedFiles,
                perFilePatches: input.perFilePatches, maxLinesForPatches: maxLinesForPatches
            )
            let bytes = try JSONEncoder().encode(diff)
            return try ["kind": "gitDiff", "diff": decodeWireJSON(bytes)]
        }
    }
}
