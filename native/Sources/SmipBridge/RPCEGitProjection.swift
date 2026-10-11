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
}
