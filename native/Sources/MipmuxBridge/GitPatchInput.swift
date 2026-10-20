import Foundation

struct GitPatchInput {
    private let text: String

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "text"])
        text = try fields.string("text")
    }

    func render() -> [String: Any] {
        let patches = RPCEGitPatchSplitter.splitUnifiedDiffByFile(text)
        let files = patches.sorted { $0.key < $1.key }.map { path, patch -> [String: Any] in
            let counts = GitDiffPatchParsing.countChanges(in: patch)
            let hunks = GitDiffPatchParsing.parseHunks(from: patch).map { hunk -> [String: Any] in
                ["header": hunk.header, "oldStart": hunk.oldStart, "oldLines": hunk.oldLines,
                 "newStart": hunk.newStart, "newLines": hunk.newLines, "content": hunk.content]
            }
            return ["path": path, "patch": patch, "insertions": counts.insertions,
                    "deletions": counts.deletions, "hunks": hunks]
        }
        return ["kind": "gitPatch", "files": files,
                "changedLinesTsv": GitDiffPatchParsing.buildChangedLinesTsv(from: patches)]
    }
}
