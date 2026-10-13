// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

// swiftlint:disable file_length
// swiftlint:disable:next type_body_length
enum GitDiffMapBuilder {
    struct Inputs {
        let snapshotID: String
        let snapshotDir: String
        let generatedAt: Date
        let mode: GitDiffPublishMode
        let compareRaw: String
        let compareInput: String?
        let scope: GitDiffScope
        let requestedPaths: [String]?
        let fingerprint: GitDiffFingerprint
        let contextLines: Int
        let detectRenames: Bool
        let summary: GitDiffSnapshotManifest.Summary
        let files: [GitDiffSnapshotManifest.FileEntry]
        let commitGraph: String
        let treeText: String
        let jumpTableText: String
        let artifacts: [String: String]
        // Multi-root metadata (optional)
        let repoKey: String?
        let repoRoot: String?

        // Worktree metadata (optional)
        let isWorktree: Bool?
        let worktreeName: String?
        let worktreeRoot: String?
        let mainWorktreeRoot: String?
        let commonGitDir: String?

        init(
            snapshotID: String,
            snapshotDir: String,
            generatedAt: Date,
            mode: GitDiffPublishMode,
            compareRaw: String,
            compareInput: String?,
            scope: GitDiffScope,
            requestedPaths: [String]?,
            fingerprint: GitDiffFingerprint,
            contextLines: Int,
            detectRenames: Bool,
            summary: GitDiffSnapshotManifest.Summary,
            files: [GitDiffSnapshotManifest.FileEntry],
            commitGraph: String,
            treeText: String,
            jumpTableText: String,
            artifacts: [String: String],
            repoKey: String? = nil,
            repoRoot: String? = nil,
            isWorktree: Bool? = nil,
            worktreeName: String? = nil,
            worktreeRoot: String? = nil,
            mainWorktreeRoot: String? = nil,
            commonGitDir: String? = nil
        ) {
            self.isWorktree = isWorktree
            self.worktreeName = worktreeName
            self.worktreeRoot = worktreeRoot
            self.mainWorktreeRoot = mainWorktreeRoot
            self.commonGitDir = commonGitDir
            self.snapshotID = snapshotID
            self.snapshotDir = snapshotDir
            self.generatedAt = generatedAt
            self.mode = mode
            self.compareRaw = compareRaw
            self.compareInput = compareInput
            self.scope = scope
            self.requestedPaths = requestedPaths
            self.fingerprint = fingerprint
            self.contextLines = contextLines
            self.detectRenames = detectRenames
            self.summary = summary
            self.files = files
            self.commitGraph = commitGraph
            self.treeText = treeText
            self.jumpTableText = jumpTableText
            self.artifacts = artifacts
            self.repoKey = repoKey
            self.repoRoot = repoRoot
        }
    }

    private static var dateFormatter: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }

    static func build(_ inputs: Inputs) -> String {
        var lines: [String] = []
        appendSnapshotMetadata(inputs, lines: &lines)
        appendCheckoutMetadata(inputs, lines: &lines)
        appendArtifactMetadata(inputs, lines: &lines)
        appendContextIndexes(inputs, lines: &lines)
        appendNotes(inputs, lines: &lines)
        return lines.joined(separator: "\n")
    }

    private static func appendSnapshotMetadata(_ inputs: Inputs, lines: inout [String]) {
        lines.append("# MAP.txt v1")
        lines.append("# (grep tip: search for \"SNAPSHOT_\" or \"SECTION:\")")
        lines.append("")
        lines.append("SECTION: SNAPSHOT_META")
        lines.append("SNAPSHOT_ID: \(inputs.snapshotID)")
        lines.append("SNAPSHOT_DIR: \(inputs.snapshotDir)")
        lines.append("SNAPSHOT_GENERATED_AT: \(dateFormatter.string(from: inputs.generatedAt))")
        lines.append("SNAPSHOT_MODE: \(inputs.mode.rawValue)")
        lines.append("SNAPSHOT_MODE_DETAILS: \(modeDetails(for: inputs.mode))")
        lines.append("SNAPSHOT_COMPARE: \(inputs.compareRaw)")
        if let compareInput = inputs.compareInput, compareInput != inputs.compareRaw {
            lines.append("SNAPSHOT_COMPARE_INPUT: \(compareInput)")
        }
        lines.append("SNAPSHOT_SCOPE: \(inputs.scope.rawValue)")
        if let requestedPaths = inputs.requestedPaths {
            lines.append("SNAPSHOT_SELECTED_PATHS_COUNT: \(requestedPaths.count)")
        }
        lines.append("SNAPSHOT_CHANGED_FILES: \(inputs.summary.files)")
        lines.append("SNAPSHOT_INSERTIONS: \(inputs.summary.insertions)")
        lines.append("SNAPSHOT_DELETIONS: \(inputs.summary.deletions)")
    }

    private static func appendCheckoutMetadata(_ inputs: Inputs, lines: inout [String]) {
        // Multi-root metadata (when available)
        if let repoKey = inputs.repoKey {
            lines.append("")
            lines.append("SECTION: REPOSITORY")
            lines.append("REPO_KEY: \(repoKey)")
            if let repoRoot = inputs.repoRoot {
                lines.append("REPO_ROOT: \(repoRoot)")
            }
        }

        if inputs.isWorktree == true {
            lines.append("")
            lines.append("SECTION: WORKTREE")
            lines.append("WORKTREE_IS_WORKTREE: true")
            if let worktreeName = inputs.worktreeName {
                lines.append("WORKTREE_NAME: \(worktreeName)")
            }
            if let worktreeRoot = inputs.worktreeRoot {
                lines.append("WORKTREE_ROOT: \(worktreeRoot)")
            }
            if let mainRoot = inputs.mainWorktreeRoot {
                lines.append("WORKTREE_MAIN_ROOT: \(mainRoot)")
            }
            if let commonGitDir = inputs.commonGitDir {
                lines.append("WORKTREE_COMMON_GIT_DIR: \(commonGitDir)")
            }
        }
    }

    private static func appendArtifactMetadata(_ inputs: Inputs, lines: inout [String]) {
        lines.append("")
        lines.append("SECTION: FINGERPRINT")
        lines.append("FINGERPRINT_HEAD_SHA: \(inputs.fingerprint.headSHA)")
        lines.append("FINGERPRINT_BASE_REF: \(inputs.fingerprint.baseRef)")
        lines.append("FINGERPRINT_STATUS_HASH: \(inputs.fingerprint.statusHash)")

        lines.append("")
        lines.append("SECTION: ADVANCED")
        lines.append("ADV_CONTEXT_LINES: \(inputs.contextLines)")
        lines.append("ADV_DETECT_RENAMES: \(inputs.detectRenames)")

        lines.append("")
        lines.append("SECTION: ARTIFACTS")
        if let manifest = inputs.artifacts["manifest"] {
            lines.append("ARTIFACT_MANIFEST: \(manifest)")
        }
        if let map = inputs.artifacts["map"] {
            lines.append("ARTIFACT_MAP: \(map)")
        }
        if let filesTsv = inputs.artifacts["files_tsv"] {
            lines.append("ARTIFACT_FILES_TSV: \(filesTsv)")
        }
        if let changedLines = inputs.artifacts["changed_lines"] {
            lines.append("ARTIFACT_CHANGED_LINES: \(changedLines)")
        }
        if let tree = inputs.artifacts["tree"] {
            lines.append("ARTIFACT_TREE: \(tree)")
        }
        if let selection = inputs.artifacts["selection_paths"] {
            lines.append("ARTIFACT_SELECTION_PATHS: \(selection)")
        }
        if let allPatch = inputs.artifacts["all_patch"] {
            lines.append("ARTIFACT_ALL_PATCH: \(allPatch)")
        }
        if let deepHunks = inputs.artifacts["deep_hunks"] {
            lines.append("ARTIFACT_DEEP_HUNKS: \(deepHunks)")
        }
        if let deepChanged = inputs.artifacts["deep_changed_lines"] {
            lines.append("ARTIFACT_DEEP_CHANGED_LINES: \(deepChanged)")
        }
    }

    private static func appendContextIndexes(_ inputs: Inputs, lines: inout [String]) {
        if inputs.artifacts["changed_lines"] != nil {
            lines.append("")
            lines.append("SECTION: CHANGED_LINES_FORMAT")
            lines.append("index/changed_lines.tsv: TSV columns: path, line_number, change_type(+/-), content")
            lines.append("  - line_number: new-file line for '+', old-file line for '-'")
        }

        if inputs.mode == .deep {
            lines.append("")
            lines.append("SECTION: DEEP_FORMAT")
            lines.append("deep/hunks.jsonl: JSONL records {path, header, old_start, old_count, new_start, new_count}")
            lines.append("deep/changed_lines.tsv: TSV columns: path, op(+/-), old_line, new_line, text")
        }

        if let requestedPaths = inputs.requestedPaths {
            lines.append("")
            lines.append("SECTION: SELECTION_PATHS")
            lines.append("(selection.paths.txt is the canonical list; shown here for convenience)")
            for path in requestedPaths {
                lines.append("- \(path)")
            }
        }

        lines.append("")
        lines.append("SECTION: COMMIT_GRAPH")
        lines.append(inputs.commitGraph)

        lines.append("")
        lines.append("SECTION: CHANGED_FILE_TREE")
        lines.append(inputs.treeText)

        lines.append("")
        lines.append("SECTION: JUMP_TABLE")
        lines.append(inputs.jumpTableText)

        if let perFileSelectionPathsText = buildPerFilePatchSelectionPathsText(
            snapshotDir: inputs.snapshotDir,
            files: inputs.files
        ) {
            lines.append("")
            lines.append("SECTION: PER_FILE_PATCH_SELECTION_PATHS")
            lines.append(perFileSelectionPathsText)
        }
    }

    private static func appendNotes(_ inputs: Inputs, lines: inout [String]) {
        lines.append("")
        lines.append("SECTION: NOTES")
        let omittedCount = inputs.files.count(where: { $0.patchPath == nil })
        let binaryCount = inputs.files.count(where: { $0.additions == nil && $0.deletions == nil })
        lines.append("NOTE_PATCH_OMITTED_COUNT: \(omittedCount)")
        if omittedCount > 0, inputs.mode == .quick {
            lines.append("NOTE_PATCH_OMITTED_REASON: quick_mode")
        }
        lines.append("NOTE_QUICK_MODE: \(inputs.mode == .quick)")
        if let emptyReason = emptyReason(
            summary: inputs.summary,
            scope: inputs.scope,
            requestedPaths: inputs.requestedPaths,
            compareRaw: inputs.compareRaw
        ) {
            lines.append("NOTE_EMPTY_RESULT: true")
            lines.append("NOTE_EMPTY_REASON: \(emptyReason)")
        }
        if binaryCount > 0 {
            lines.append("NOTE_BINARY_FILES: \(binaryCount)")
        }

        if binaryCount > 0 {
            lines.append("")
            lines.append("SECTION: BINARY_FILES")
            let binaryFiles = inputs.files.filter { $0.additions == nil && $0.deletions == nil }
            for entry in binaryFiles {
                let status = entry.status ?? ""
                let label = status.isEmpty ? entry.gitPath : "\(status) \(entry.gitPath)"
                lines.append("- \(label)")
            }
        }
    }

    // swiftlint:disable large_tuple
    static func inlineExcerpt(from fullMap: String, maxLines: Int,
                              sections: [String]? = nil) -> (
        excerpt: String,
        truncated: Bool,
        totalLines: Int,
        returnedLines: Int
    ) {
        guard maxLines > 0 else { return ("", false, 0, 0) }
        let mapText = sections.flatMap { extractSections(from: fullMap, sections: $0) } ?? fullMap
        let lines = mapText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let truncated = lines.count > maxLines
        let excerpt = lines.prefix(maxLines).joined(separator: "\n")
        return (excerpt, truncated, lines.count, min(maxLines, lines.count))
    }

    // swiftlint:enable large_tuple

    private static func extractSections(from fullMap: String, sections: [String]) -> String? {
        guard !sections.isEmpty else { return nil }
        let lines = fullMap.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var headerLines: [String] = []
        var sectionBlocks: [String: [String]] = [:]
        var currentName: String?
        var currentLines: [String] = []
        var sawFirstSection = false

        func flush() {
            guard let name = currentName else { return }
            sectionBlocks[name] = currentLines
            currentName = nil
            currentLines = []
        }

        for line in lines {
            if line.hasPrefix("SECTION: ") {
                if currentName != nil {
                    flush()
                } else if !sawFirstSection {
                    sawFirstSection = true
                }
                let name = line.replacingOccurrences(of: "SECTION: ", with: "")
                currentName = name
                currentLines = [line]
                continue
            }
            // swiftlint:disable:next unused_optional_binding
            if let _ = currentName {
                currentLines.append(line)
            } else if !sawFirstSection {
                headerLines.append(line)
            }
        }
        if currentName != nil {
            flush()
        }

        return joinSections(headerLines, blocks: sectionBlocks, sections: sections)
    }

    private static func joinSections(
        _ headerLines: [String],
        blocks sectionBlocks: [String: [String]],
        sections: [String]
    ) -> String? {
        var output: [String] = []
        if !headerLines.isEmpty {
            output.append(contentsOf: headerLines)
        }
        for section in sections {
            if let block = sectionBlocks[section] {
                if !output.isEmpty {
                    output.append("")
                }
                output.append(contentsOf: block)
            }
        }
        let text = output.joined(separator: "\n")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func buildPerFilePatchSelectionPathsText(
        snapshotDir: String,
        files: [GitDiffSnapshotManifest.FileEntry]
    ) -> String? {
        let patches = GitDiffSnapshotStore.perFilePatchArtifacts(snapshotDir: snapshotDir, files: files)
        guard !patches.isEmpty else { return nil }

        let indexWidth = max(2, String(patches.map(\.jumpIndex).max() ?? 0).count)
        var lines: [String] = []
        lines
            .append(
                // swiftlint:disable:next line_length
                "(selection-ready `_git_data/...` paths for direct selection; no manual snapshot-dir reconstruction or `__` filename encoding required)"
            )
        for patch in patches {
            let idxText = String(format: "%0*d", indexWidth, patch.jumpIndex)
            let status = perFilePatchStatusSummary(patch)
            lines.append("[\(idxText)] \(status)  \(patch.gitPath) -> \(patch.selectionPath)")
        }
        return lines.joined(separator: "\n")
    }

    private static func perFilePatchStatusSummary(_ patch: GitDiffPerFilePatchArtifact) -> String {
        let status = patch.status ?? ""
        let add = patch.additions.map { "+\($0)" } ?? "+?"
        let del = patch.deletions.map { "-\($0)" } ?? "-?"
        if status.isEmpty {
            return "\(add) \(del)"
        }
        return "\(status) \(add) \(del)"
    }

    static func modeDetails(for mode: GitDiffPublishMode) -> String {
        switch mode {
        case .quick:
            "quick: no patch text, summary-only artifacts"
        case .standard:
            "standard: full diff patches (all.patch + per-file when size allows)"
        case .deep:
            "deep: standard patches + hunk and changed-line indexes"
        }
    }

    static func emptyReason(
        summary: GitDiffSnapshotManifest.Summary,
        scope: GitDiffScope,
        requestedPaths: [String]?,
        compareRaw: String
    ) -> String? {
        guard summary.files == 0 else { return nil }
        if scope == .selected {
            if requestedPaths?.isEmpty ?? true {
                return "selection_empty"
            }
            return "no_changes_in_selected_paths"
        }
        let lowered = compareRaw.lowercased()
        if lowered == "staged" || lowered.hasPrefix("staged:") {
            return "no_staged_changes"
        }
        if lowered == "unstaged" {
            return "no_unstaged_changes"
        }
        if lowered == "uncommitted" || lowered.hasPrefix("uncommitted:") {
            return "no_uncommitted_changes"
        }
        return "no_changes"
    }
}
