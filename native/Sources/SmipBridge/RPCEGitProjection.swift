// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: omit desktop worker/telemetry wrappers; preserve the source DTO projection.
import Foundation

enum RPCEGitProjection {
    static func makeShowDTO(
        commitInfo: VCSCommitInfo, changedFiles: [VCSUncommittedFile], detail: String, diffText: String?
    ) -> ShowDTO {
        let totals = totals(from: changedFiles)
        var files: [DiffFileDTO]?
        if detail == "files" || detail == "full" {
            files = diffFileDTOsWithoutHunks(from: changedFiles)
        }
        if detail == "full", let diffText {
            let perFilePatches = RPCEGitPatchSplitter.splitUnifiedDiffByFile(diffText)
            files = filesWithParsedHunks(
                changedFiles: changedFiles,
                perFilePatches: perFilePatches,
                nilWhenEmpty: true
            )
        }
        return ShowDTO(
            sha: commitInfo.id,
            shortSha: commitInfo.shortID,
            author: commitInfo.author,
            date: commitInfo.dateISO,
            message: commitInfo.message,
            files: files,
            totals: totals,
            hunks: nil
        )
    }

    private nonisolated static func totals(from files: [VCSUncommittedFile]) -> TotalsDTO {
        TotalsDTO(
            files: files.count,
            insertions: files.reduce(0) { $0 + ($1.additions ?? 0) },
            deletions: files.reduce(0) { $0 + ($1.deletions ?? 0) }
        )
    }

    private nonisolated static func hunkDTOs(
        from hunks: [GitDiffPatchParsing.ParsedHunk],
        nilWhenEmpty: Bool
    ) -> [DiffHunkDTO]? {
        if nilWhenEmpty, hunks.isEmpty { return nil }
        return hunks.map { hunk in
            DiffHunkDTO(
                header: hunk.header,
                oldStart: hunk.oldStart,
                newStart: hunk.newStart,
                patch: hunk.content
            )
        }
    }

    private nonisolated static func diffFileDTOsWithoutHunks(
        from changedFiles: [VCSUncommittedFile]
    ) -> [DiffFileDTO] {
        changedFiles.map { file in
            DiffFileDTO(
                path: file.path,
                status: file.status,
                insertions: file.additions,
                deletions: file.deletions,
                hunks: nil
            )
        }
    }

    private nonisolated static func filesWithParsedHunks(
        changedFiles: [VCSUncommittedFile],
        perFilePatches: [String: String],
        nilWhenEmpty: Bool
    ) -> [DiffFileDTO] {
        changedFiles.map { file in
            let patchText = perFilePatches[file.path] ?? ""
            let hunks = patchText.isEmpty ? [] : GitDiffPatchParsing.parseHunks(from: patchText)
            return DiffFileDTO(
                path: file.path,
                status: file.status,
                insertions: file.additions,
                deletions: file.deletions,
                hunks: hunkDTOs(from: hunks, nilWhenEmpty: nilWhenEmpty)
            )
        }
    }

    static func makeDiffDTO(
        compare: String,
        detail: String,
        changedFiles: [VCSUncommittedFile],
        perFilePatches: [String: String]?,
        maxLinesForPatches: Int
    ) -> DiffDTO {
        let includesHunks = detail == "patches" || detail == "full"
        let totals = totals(from: changedFiles)
        var files: [DiffFileDTO]?
        var truncated: Bool?
        var truncationNote: String?

        if detail == "files" || includesHunks {
            files = diffFileDTOsWithoutHunks(from: changedFiles)
        }
        if includesHunks, let perFilePatches {
            let parsedFiles = parsedFileHunks(
                changedFiles: changedFiles,
                perFilePatches: perFilePatches
            )
            let truncation = GitDiffPatchParsing.truncatePatches(
                files: parsedFiles,
                maxLines: maxLinesForPatches
            )
            truncated = truncation.truncated
            truncationNote = truncation.note
            files = truncation.files.map { file in
                DiffFileDTO(
                    path: file.path,
                    status: file.status,
                    insertions: file.insertions,
                    deletions: file.deletions,
                    hunks: hunkDTOs(from: file.hunks, nilWhenEmpty: false)
                )
            }
        }

        return DiffDTO(
            compare: compare,
            detail: detail,
            files: files,
            totals: totals,
            byStatus: statusBreakdown(from: changedFiles),
            oneliner: oneliner(
                files: totals.files,
                insertions: totals.insertions,
                deletions: totals.deletions
            ),
            truncated: truncated,
            truncationNote: truncationNote
        )
    }

    private nonisolated static func statusBreakdown(from files: [VCSUncommittedFile]) -> [String: Int]? {
        var counts: [String: Int] = [:]
        for file in files {
            counts[file.status, default: 0] += 1
        }
        return counts.isEmpty ? nil : counts
    }

    private nonisolated static func oneliner(files: Int, insertions: Int, deletions: Int) -> String {
        "\(files) files (+\(insertions) -\(deletions))"
    }

    private nonisolated static func parsedFileHunks(
        changedFiles: [VCSUncommittedFile],
        perFilePatches: [String: String]
    ) -> [GitDiffPatchParsing.ParsedFileHunks] {
        var parsedFiles: [GitDiffPatchParsing.ParsedFileHunks] = []
        parsedFiles.reserveCapacity(changedFiles.count)
        for file in changedFiles {
            guard let patchText = perFilePatches[file.path] else { continue }
            let hunks = patchText.isEmpty ? [] : GitDiffPatchParsing.parseHunks(from: patchText)
            parsedFiles.append(GitDiffPatchParsing.ParsedFileHunks(
                path: file.path,
                status: file.status,
                insertions: file.additions ?? 0,
                deletions: file.deletions ?? 0,
                hunks: hunks
            ))
        }

        return parsedFiles
    }
}
