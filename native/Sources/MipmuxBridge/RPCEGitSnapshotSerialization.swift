// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Crypto
import Foundation

struct GitDiffSnapshotStore {
    func snapshotRelativePath(repoKey: String, snapshotID: String) -> String {
        "repos/\(repoKey)/\(snapshotID)"
    }

    static func encodeGitPathForPatchFileName(_ gitPath: String) -> String {
        var normalized = gitPath
        if normalized.hasPrefix("./") {
            normalized = String(normalized.dropFirst(2))
        }
        normalized = normalized.replacingOccurrences(of: "/", with: "__")
        normalized = normalized.replacingOccurrences(of: " ", with: "_")
        if normalized.isEmpty {
            normalized = "file"
        }
        let ext = ".patch"
        var name = normalized + ext
        let maxLength = 180
        if name.count > maxLength {
            let hash = sha256Hex(Data(name.utf8)).prefix(8)
            let keep = max(1, maxLength - ext.count - hash.count - 1)
            let prefix = String(normalized.prefix(keep))
            name = prefix + "-" + hash + ext
        }
        return name
    }

    static func normalizeSnapshotID(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~") {
            return nil
        }
        var cleaned = trimmed
        while cleaned.hasPrefix("/") {
            cleaned.removeFirst()
        }
        while cleaned.hasSuffix("/") {
            cleaned.removeLast()
        }
        guard !cleaned.isEmpty else { return nil }
        if cleaned.lowercased() == "current" {
            return nil
        }
        let parts = cleaned.split(separator: "/").map(String.init)
        for part in parts {
            if part == "." || part == ".." || part.isEmpty {
                return nil
            }
            if part.contains(":") {
                return nil
            }
        }
        return parts.joined(separator: "/")
    }

    // Source snapshot bytes go through the caller's writer rather than unrestricted filesystem paths.
    // swiftlint:disable:next function_body_length function_parameter_count
    func writeSnapshot(
        repoKey: String,
        snapshotID: String,
        mode: GitDiffPublishMode,
        compareRaw: String,
        compareInput: String?,
        scope: GitDiffScope,
        requestedPaths: [String]?,
        fingerprint: GitDiffFingerprint,
        contextLines: Int,
        detectRenames: Bool,
        inputs: GitSnapshotContent,
        commitGraph: String,
        repoRoot: String? = nil,
        tabID: UUID? = nil,
        metadata: GitSnapshotWorktree?,
        writeFile: (String, Data) throws -> Void
    ) throws -> GitDiffSnapshotManifest {
        let snapshotDir = URL(fileURLWithPath: "/snapshot")
        let snapshotDirRel = snapshotRelativePath(repoKey: repoKey, snapshotID: snapshotID)
        let indexDir = snapshotDir.appendingPathComponent("index", isDirectory: true)

        let generatedAt = Date()
        let patches = try writePatches(inputs, mode: mode, snapshotDir: snapshotDir, writeFile: writeFile)
        let writtenPatches = patches.perFile
        let allPatchPath = patches.allPath

        let orderedChanges = inputs.changedFiles
            .sorted { $0.path.localizedCaseInsensitiveCompare($1.path) == .orderedAscending }
        let fileEntries: [GitDiffSnapshotManifest.FileEntry] = orderedChanges.map { file in
            let patch = writtenPatches[file.path]
            return GitDiffSnapshotManifest.FileEntry(
                gitPath: file.path,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                patchPath: patch?.path,
                bytes: patch?.bytes,
                lines: patch?.lines,
                hunks: patch?.hunks
            )
        }

        let summary = GitDiffSnapshotManifest.Summary(
            files: inputs.summary.files,
            insertions: inputs.summary.insertions,
            deletions: inputs.summary.deletions
        )
        let worktreeMeta = metadata

        let manifest = GitDiffSnapshotManifest(
            snapshotID: snapshotID,
            generatedAt: generatedAt,
            mode: mode,
            compare: compareRaw,
            compareInput: compareInput,
            scope: scope,
            requestedPaths: requestedPaths,
            fingerprint: fingerprint,
            contextLines: contextLines,
            detectRenames: detectRenames,
            summary: summary,
            files: fileEntries,
            repoKey: repoKey,
            repoRoot: repoRoot,
            isWorktree: worktreeMeta?.isWorktree,
            worktreeName: worktreeMeta?.worktreeName,
            worktreeRoot: worktreeMeta?.worktreeRoot,
            mainWorktreeRoot: worktreeMeta?.mainWorktreeRoot,
            commonGitDir: worktreeMeta?.commonGitDir,
            tabID: tabID
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let manifestData = try encoder.encode(manifest)
        let manifestURL = snapshotDir.appendingPathComponent("manifest.json")
        try writeFile(relativePath(from: snapshotDir, to: manifestURL), manifestData)

        let filesTsvURL = indexDir.appendingPathComponent("files.tsv")
        let filesTsv = buildFilesTsv(files: fileEntries)
        try writeFile(relativePath(from: snapshotDir, to: filesTsvURL), Data(filesTsv.utf8))

        var changedLinesTsvWritten = false
        if mode != .quick, let perFile = inputs.perFile, !perFile.isEmpty {
            let changedLinesTsv = GitDiffPatchParsing.buildChangedLinesTsv(from: perFile)
            let changedLinesURL = indexDir.appendingPathComponent("changed_lines.tsv")
            try writeFile(relativePath(from: snapshotDir, to: changedLinesURL), Data(changedLinesTsv.utf8))
            changedLinesTsvWritten = true
        }

        let treeText = buildChangedFileTreeText(files: fileEntries)
        let treeURL = indexDir.appendingPathComponent("files.tree.txt")
        try writeFile(relativePath(from: snapshotDir, to: treeURL), Data(treeText.utf8))

        if let requestedPaths {
            let selectionURL = indexDir.appendingPathComponent("selection.paths.txt")
            let selectionText = requestedPaths.joined(separator: "\n")
            try writeFile(relativePath(from: snapshotDir, to: selectionURL), Data(selectionText.utf8))
        }

        if mode == .deep {
            let deepDir = snapshotDir.appendingPathComponent("deep", isDirectory: true)
            let deep = parseDeepArtifacts(perFilePatches: writtenPatches)
            let hunksURL = deepDir.appendingPathComponent("hunks.jsonl")
            let linesURL = deepDir.appendingPathComponent("changed_lines.tsv")
            try writeFile(relativePath(from: snapshotDir, to: hunksURL), Data(deep.hunksJsonl.utf8))
            try writeFile(relativePath(from: snapshotDir, to: linesURL), Data(deep.changedLinesTsv.utf8))
        }

        var artifacts: [String: String] = [
            "manifest": "manifest.json",
            "map": "MAP.txt",
            "files_tsv": "index/files.tsv",
            "tree": "index/files.tree.txt"
        ]
        if changedLinesTsvWritten {
            artifacts["changed_lines"] = "index/changed_lines.tsv"
        }
        if requestedPaths != nil {
            artifacts["selection_paths"] = "index/selection.paths.txt"
        }
        if let allPatchPath {
            artifacts["all_patch"] = allPatchPath
        }
        if mode == .deep {
            artifacts["deep_hunks"] = "deep/hunks.jsonl"
            artifacts["deep_changed_lines"] = "deep/changed_lines.tsv"
        }

        let mapText = GitDiffMapBuilder.build(
            GitDiffMapBuilder.Inputs(
                snapshotID: snapshotID,
                snapshotDir: snapshotDirRel,
                generatedAt: generatedAt,
                mode: mode,
                compareRaw: compareRaw,
                compareInput: compareInput,
                scope: scope,
                requestedPaths: requestedPaths,
                fingerprint: fingerprint,
                contextLines: contextLines,
                detectRenames: detectRenames,
                summary: summary,
                files: fileEntries,
                commitGraph: commitGraph,
                treeText: treeText,
                jumpTableText: buildJumpTableText(files: fileEntries),
                artifacts: artifacts,
                repoKey: repoKey,
                repoRoot: repoRoot,
                isWorktree: worktreeMeta?.isWorktree,
                worktreeName: worktreeMeta?.worktreeName,
                worktreeRoot: worktreeMeta?.worktreeRoot,
                mainWorktreeRoot: worktreeMeta?.mainWorktreeRoot,
                commonGitDir: worktreeMeta?.commonGitDir
            )
        )
        let mapURL = snapshotDir.appendingPathComponent("MAP.txt")
        try writeFile(relativePath(from: snapshotDir, to: mapURL), Data(mapText.utf8))

        return manifest
    }

    private func writePatches(_ inputs: GitSnapshotContent, mode: GitDiffPublishMode, snapshotDir: URL,
                              writeFile: (String, Data) throws -> Void) throws
        -> (perFile: [String: PatchInfo], allPath: String?) {
        var writtenPatches: [String: PatchInfo] = [:]
        var allPatchPath: String?

        if mode != .quick {
            if let perFile = inputs.perFile, !perFile.isEmpty {
                let diffDir = snapshotDir.appendingPathComponent("diff", isDirectory: true)
                let perFileDir = diffDir.appendingPathComponent("per-file", isDirectory: true)

                for (gitPath, diffText) in perFile
                    .sorted(by: { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }) {
                    let data = Data(diffText.utf8)
                    let fileName = Self.encodeGitPathForPatchFileName(gitPath)
                    let fileURL = perFileDir.appendingPathComponent(fileName)
                    try writeFile(relativePath(from: snapshotDir, to: fileURL), data)
                    let linesCount = diffText.split(separator: "\n", omittingEmptySubsequences: false).count
                    let hunks = buildHunkIndex(for: diffText)
                    let relPath = relativePath(from: snapshotDir, to: fileURL)
                    writtenPatches[gitPath] = PatchInfo(
                        path: relPath,
                        bytes: data.count,
                        lines: linesCount,
                        hunks: hunks,
                        text: diffText
                    )
                }
            }

            if let diffText = inputs.diffText, !diffText.isEmpty {
                let diffDir = snapshotDir.appendingPathComponent("diff", isDirectory: true)
                let allPatchURL = diffDir.appendingPathComponent("all.patch")
                let data = Data(diffText.utf8)
                try writeFile(relativePath(from: snapshotDir, to: allPatchURL), data)
                allPatchPath = relativePath(from: snapshotDir, to: allPatchURL)
            }
        }

        return (writtenPatches, allPatchPath)
    }
}
