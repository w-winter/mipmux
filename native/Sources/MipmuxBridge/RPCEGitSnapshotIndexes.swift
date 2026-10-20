// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Crypto
import Foundation

extension GitDiffSnapshotStore {
    func relativePath(from base: URL, to url: URL) -> String {
        let basePath = (base.path as NSString).standardizingPath
        let targetPath = (url.path as NSString).standardizingPath
        if targetPath.hasPrefix(basePath) {
            var rel = String(targetPath.dropFirst(basePath.count))
            if rel.hasPrefix("/") {
                rel.removeFirst()
            }
            return rel
        }
        let baseLower = basePath.lowercased()
        let targetLower = targetPath.lowercased()
        if targetLower.hasPrefix(baseLower) {
            var rel = String(targetPath.dropFirst(basePath.count))
            if rel.hasPrefix("/") {
                rel.removeFirst()
            }
            return rel
        }
        return url.path
    }

    func buildHunkIndex(for diffText: String) -> [DiffHunkIndex]? {
        let lines = diffText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard !lines.isEmpty else { return nil }

        var hunks: [DiffHunkIndex] = []
        var currentHeader: String?
        var currentStart: Int?

        func flush(at endLine: Int) {
            guard let header = currentHeader, let start = currentStart else { return }
            hunks.append(DiffHunkIndex(header: header, startLine: start, endLine: endLine))
            currentHeader = nil
            currentStart = nil
        }

        for (index, line) in lines.enumerated() {
            let lineNumber = index + 1
            if line.hasPrefix("@@") {
                if currentHeader != nil {
                    flush(at: lineNumber - 1)
                }
                currentHeader = line
                currentStart = lineNumber
            }
        }

        // swiftlint:disable:next unused_optional_binding
        if let _ = currentHeader, let _ = currentStart {
            flush(at: lines.count)
        }

        return hunks.isEmpty ? nil : hunks
    }

    func buildFilesTsv(files: [GitDiffSnapshotManifest.FileEntry]) -> String {
        var lines: [String] = []
        lines.append("status\tadditions\tdeletions\tgit_path\tpatch_path\tbytes\tlines")
        for entry in files {
            let status = entry.status ?? ""
            let add = entry.additions.map(String.init) ?? ""
            let del = entry.deletions.map(String.init) ?? ""
            let patch = entry.patchPath ?? ""
            let bytes = entry.bytes.map(String.init) ?? ""
            let linesCount = entry.lines.map(String.init) ?? ""
            lines.append([status, add, del, entry.gitPath, patch, bytes, linesCount].joined(separator: "\t"))
        }
        return lines.joined(separator: "\n")
    }

    func sortCaseInsensitiveKeys(_ keys: [String]) -> [String] {
        let keyed = keys.map { key in
            (lower: key.lowercased(), original: key)
        }
        return keyed.sorted { lhs, rhs in
            if lhs.lower != rhs.lower {
                return lhs.lower < rhs.lower
            }
            return lhs.original < rhs.original
        }.map(\.original)
    }

    func sortCaseInsensitive<T>(_ items: [T], key: (T) -> String) -> [T] {
        let keyed = items.map { value in
            let original = key(value)
            return (lower: original.lowercased(), original: original, value: value)
        }
        return keyed.sorted { lhs, rhs in
            if lhs.lower != rhs.lower {
                return lhs.lower < rhs.lower
            }
            return lhs.original < rhs.original
        }.map(\.value)
    }

    func statusSummary(for entry: GitDiffSnapshotManifest.FileEntry) -> String {
        let status = entry.status ?? ""
        let add = entry.additions.map { "+\($0)" } ?? "+?"
        let del = entry.deletions.map { "-\($0)" } ?? "-?"
        if status.isEmpty {
            return "\(add) \(del)"
        }
        return "\(status) \(add) \(del)"
    }

    static func displayOrderedFiles(_ files: [GitDiffSnapshotManifest.FileEntry])
        -> [GitDiffSnapshotManifest.FileEntry] {
        files.sorted { lhs, rhs in
            let lhsLower = lhs.gitPath.lowercased()
            let rhsLower = rhs.gitPath.lowercased()
            if lhsLower != rhsLower {
                return lhsLower < rhsLower
            }
            return lhs.gitPath < rhs.gitPath
        }
    }

    func buildJumpTableText(files: [GitDiffSnapshotManifest.FileEntry]) -> String {
        let ordered = Self.displayOrderedFiles(files)
        let indexWidth = max(2, String(ordered.count).count)
        var lines: [String] = []
        for (index, entry) in ordered.enumerated() {
            let idx = index + 1
            let idxText = String(format: "%0*d", indexWidth, idx)
            let status = statusSummary(for: entry)
            let target = entry.patchPath ?? "(no patch)"
            lines.append("[\(idxText)] \(status)  \(entry.gitPath) -> \(target)")
        }
        return lines.joined(separator: "\n")
    }

    func buildChangedFileTreeText(files: [GitDiffSnapshotManifest.FileEntry]) -> String {
        let ordered = Self.displayOrderedFiles(files)
        let indexWidth = max(2, String(ordered.count).count)
        // Duplicate-tolerant (last-wins) so duplicated git paths never trap —
        // they should be unique per snapshot, but the tree render should not
        // SIGTRAP if the manifest ever repeats a path.
        let indexMap = Dictionary(
            ordered.enumerated().map { offset, entry in (entry.gitPath, offset + 1) },
            uniquingKeysWith: { _, last in last }
        )

        let root = TreeNode(name: "")
        for entry in ordered {
            let parts = entry.gitPath.split(separator: "/").map(String.init)
            var node = root
            for (idx, part) in parts.enumerated() {
                let isLeaf = idx == parts.count - 1
                let child = node.children[part] ?? TreeNode(name: part)
                if isLeaf {
                    child.fileEntry = entry
                }
                node.children[part] = child
                node = child
            }
        }

        var output: [String] = []
        func render(node: TreeNode, indent: String) {
            let dirs = sortCaseInsensitive(node.children.values.filter { $0.fileEntry == nil }, key: { $0.name })
            let files = sortCaseInsensitive(node.children.values.filter { $0.fileEntry != nil }, key: { $0.name })
            for dir in dirs {
                output.append("\(indent)\(dir.name)/")
                render(node: dir, indent: indent + "  ")
            }
            for file in files {
                guard let entry = file.fileEntry else { continue }
                let idx = indexMap[entry.gitPath] ?? 0
                let idxText = String(format: "%0*d", indexWidth, idx)
                let status = statusSummary(for: entry)
                output.append("\(indent)\(file.name)  [\(idxText)] \(status)")
            }
        }
        render(node: root, indent: "")
        return output.joined(separator: "\n")
    }

    func parseDeepArtifacts(perFilePatches: [String: PatchInfo]) -> (hunksJsonl: String, changedLinesTsv: String) {
        let orderedKeys = sortCaseInsensitiveKeys(Array(perFilePatches.keys))
        var hunksLines: [String] = []
        var changedLines: [String] = []
        let encoder = JSONEncoder()

        for gitPath in orderedKeys {
            guard let patch = perFilePatches[gitPath] else { continue }
            let parsed = parseDeepPatch(gitPath, patch: patch, encoder: encoder)
            hunksLines.append(contentsOf: parsed.hunks)
            changedLines.append(contentsOf: parsed.changes)
        }

        return (hunksLines.joined(separator: "\n"), changedLines.joined(separator: "\n"))
    }

    private func parseDeepPatch(_ gitPath: String, patch: PatchInfo,
                                encoder: JSONEncoder) -> (hunks: [String], changes: [String]) {
        var hunksLines: [String] = []
        var changedLines: [String] = []
        let lines = patch.text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var oldLine = 0
        var newLine = 0
        for line in lines {
            if line.hasPrefix("@@") {
                if let position = appendDeepHunk(gitPath, line: line, encoder: encoder, hunks: &hunksLines) {
                    oldLine = position.old
                    newLine = position.new
                }
                continue
            }
            if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff --git") || line
                .hasPrefix("index ") {
                continue
            }
            if line.hasPrefix("+") {
                let text = String(line.dropFirst())
                let row = [gitPath, "+", "", String(newLine), text].joined(separator: "\t")
                changedLines.append(row)
                newLine += 1
                continue
            }
            if line.hasPrefix("-") {
                let text = String(line.dropFirst())
                let row = [gitPath, "-", String(oldLine), "", text].joined(separator: "\t")
                changedLines.append(row)
                oldLine += 1
                continue
            }
            if line.hasPrefix(" ") {
                oldLine += 1
                newLine += 1
                continue
            }
        }
        return (hunksLines, changedLines)
    }

    private func appendDeepHunk(_ gitPath: String, line: String, encoder: JSONEncoder,
                                hunks: inout [String]) -> (old: Int, new: Int)? {
        guard let header = GitDiffPatchParsing.parseHunkHeader(line) else { return nil }
        let record = DeepHunkRecord(path: gitPath, header: line, oldStart: header.oldStart, oldCount: header.oldLines,
                                    newStart: header.newStart, newCount: header.newLines)
        if let data = try? encoder.encode(record), let json = String(data: data, encoding: .utf8) {
            hunks.append(json)
        }
        return (header.oldStart, header.newStart)
    }

    static func sha256Hex(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

struct PatchInfo {
    let path: String
    let bytes: Int
    let lines: Int
    let hunks: [DiffHunkIndex]?
    let text: String
}

final class TreeNode {
    let name: String
    var children: [String: TreeNode] = [:]
    var fileEntry: GitDiffSnapshotManifest.FileEntry?

    init(name: String) {
        self.name = name
    }
}

struct DeepHunkRecord: Codable {
    let path: String
    let header: String
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int

    enum CodingKeys: String, CodingKey {
        case path
        case header
        case oldStart = "old_start"
        case oldCount = "old_count"
        case newStart = "new_start"
        case newCount = "new_count"
    }
}
