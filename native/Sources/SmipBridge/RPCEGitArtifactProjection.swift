// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

// swiftlint:disable:next type_body_length
enum RPCEGitArtifactProjection {
    typealias Reply = RPCEGitReply

    struct ArtifactProjection {
        let diff: Reply.DiffDTO
        let artifacts: Reply.ArtifactsDTO
        let summary: Reply.SummaryDTO
        let oneliner: String
        let inputs: Reply.DiffInputsDTO
        let modeDetails: String
        let inline: Reply.InlineDTO?
        let emptyReason: String?
        let publishedArtifacts: GitDiffPublishedArtifactSet
    }

    // swiftlint:disable:next function_body_length function_parameter_count
    static func makeArtifactProjection(
        snapshotDirURL: URL,
        snapshotDir: String,
        manifest: GitDiffSnapshotManifest,
        compareDisplay: String,
        mode: GitDiffPublishMode,
        inlineMap: Bool,
        inlineMode: String,
        inlineMaxLines: Int,
        availablePaths: Set<String>,
        mapText: String?
    ) throws -> ArtifactProjection {
        let summary = summaryDTO(summary: manifest.summary, files: manifest.files)
        let artifacts = artifactsDTO(availablePaths: availablePaths, manifest: manifest)
        guard let snapshotRef = GitDiffSnapshotStore().parseSnapshotRef(snapshotDir) else {
            throw GitDiffPublishedArtifactError.invalidSnapshotReference
        }
        let publishedArtifacts = try GitDiffPublishedArtifactSet(
            snapshotDirectoryURL: snapshotDirURL,
            snapshotRef: snapshotRef,
            manifest: manifest,
            allPatchRelativePath: artifacts.allPatch
        )
        return ArtifactProjection(
            diff: Reply.DiffDTO(
                compare: compareDisplay,
                detail: nil,
                files: nil,
                totals: Reply.TotalsDTO(
                    files: summary.files,
                    insertions: summary.insertions,
                    deletions: summary.deletions
                ),
                byStatus: summary.byStatus,
                oneliner: oneliner(
                    files: summary.files,
                    insertions: summary.insertions,
                    deletions: summary.deletions
                ),
                truncated: nil,
                truncationNote: nil
            ),
            artifacts: artifacts,
            summary: summary,
            oneliner: "\(summary.files) files (+\(summary.insertions) -\(summary.deletions)) | \(snapshotDir)",
            inputs: Reply.DiffInputsDTO(
                compare: manifest.compare,
                compareInput: manifest.compareInput,
                scope: manifest.scope.rawValue,
                requestedPathsCount: manifest.requestedPaths?.count,
                contextLines: manifest.contextLines,
                detectRenames: manifest.detectRenames
            ),
            modeDetails: GitDiffMapBuilder.modeDetails(for: mode),
            inline: inlineDTO(
                mapText: mapText,
                inlineMap: inlineMap,
                inlineMode: inlineMode,
                inlineMaxLines: inlineMaxLines
            ),
            emptyReason: GitDiffMapBuilder.emptyReason(
                summary: manifest.summary,
                scope: manifest.scope,
                requestedPaths: manifest.requestedPaths,
                compareRaw: manifest.compare
            ),
            publishedArtifacts: publishedArtifacts
        )
    }

    static func makePrimaryArtifactsDTO(
        snapshotDir: String,
        artifacts: Reply.ArtifactsDTO,
        manifest: GitDiffSnapshotManifest,
        autoSelectedPaths: [String]
    ) throws -> Reply.PrimaryArtifactsDTO {
        primaryArtifactsDTO(
            snapshotDir: snapshotDir,
            artifacts: artifacts,
            manifest: manifest,
            autoSelectedPaths: autoSelectedPaths
        )
    }

    static func decorateArtifactRepoResults(
        _ repoResults: [Reply.RepoResultDTO],
        manifestsBySnapshotDir: [String: GitDiffSnapshotManifest],
        autoSelectedPaths: [String],
        readinessWarningsBySnapshotDir: [String: String] = [:]
    ) throws -> [Reply.RepoResultDTO] {
        return repoResults.map { repoResult in
            guard let snapshotDir = repoResult.snapshotDir,
                  let artifacts = repoResult.artifacts,
                  let manifest = manifestsBySnapshotDir[snapshotDir]
            else {
                return repoResult
            }
            let warning = [
                repoResult.warning,
                readinessWarningsBySnapshotDir[snapshotDir]
            ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            return Reply.RepoResultDTO(
                repoRoot: repoResult.repoRoot,
                repoKey: repoResult.repoKey,
                repoName: repoResult.repoName,
                status: repoResult.status,
                diff: repoResult.diff,
                log: repoResult.log,
                show: repoResult.show,
                blame: repoResult.blame,
                worktree: repoResult.worktree,
                snapshotId: repoResult.snapshotId,
                snapshotDir: snapshotDir,
                artifacts: artifacts,
                primaryArtifacts: primaryArtifactsDTO(
                    snapshotDir: snapshotDir,
                    artifacts: artifacts,
                    manifest: manifest,
                    autoSelectedPaths: autoSelectedPaths
                ),
                summary: repoResult.summary,
                oneliner: repoResult.oneliner,
                inputs: repoResult.inputs,
                modeDetails: repoResult.modeDetails,
                inline: repoResult.inline,
                warning: warning.isEmpty ? nil : warning,
                emptyReason: repoResult.emptyReason,
                error: repoResult.error
            )
        }
    }

    static func makeAggregateDTO(from repoDiffs: [Reply.DiffDTO], repoCount: Int) throws -> Reply.AggregateDTO {
        let totals = repoDiffs.reduce(into: (files: 0, insertions: 0, deletions: 0)) { result, diff in
            result.files += diff.totals.files
            result.insertions += diff.totals.insertions
            result.deletions += diff.totals.deletions
        }
        var byStatus: [String: Int] = [:]
        for diff in repoDiffs {
            for (status, count) in diff.byStatus ?? [:] {
                byStatus[status, default: 0] += count
            }
        }
        let totalsDTO = Reply.TotalsDTO(
            files: totals.files,
            insertions: totals.insertions,
            deletions: totals.deletions
        )
        return Reply.AggregateDTO(
            totals: totalsDTO,
            byStatus: byStatus.isEmpty ? nil : byStatus,
            oneliner: "\(repoCount) repos: \(totals.files) files (+\(totals.insertions) -\(totals.deletions))",
            repoCount: repoCount
        )
    }

    private nonisolated static func statusBreakdown(from files: [GitDiffSnapshotManifest.FileEntry]) -> [String: Int]? {
        var counts: [String: Int] = [:]
        for file in files {
            guard let status = file.status, !status.isEmpty else { continue }
            counts[status, default: 0] += 1
        }
        return counts.isEmpty ? nil : counts
    }

    private nonisolated static func summaryDTO(
        summary: GitDiffSnapshotManifest.Summary,
        files: [GitDiffSnapshotManifest.FileEntry]
    ) -> Reply.SummaryDTO {
        Reply.SummaryDTO(
            files: summary.files,
            insertions: summary.insertions,
            deletions: summary.deletions,
            byStatus: statusBreakdown(from: files)
        )
    }

    private nonisolated static func oneliner(files: Int, insertions: Int, deletions: Int) -> String {
        "\(files) files (+\(insertions) -\(deletions))"
    }

    private nonisolated static func artifactsDTO(
        availablePaths: Set<String>,
        manifest: GitDiffSnapshotManifest
    ) -> Reply.ArtifactsDTO {
        return Reply.ArtifactsDTO(
            manifest: "manifest.json",
            map: "MAP.txt",
            filesTsv: "index/files.tsv",
            changedLines: availablePaths.contains("index/changed_lines.tsv") ? "index/changed_lines.tsv" : nil,
            tree: "index/files.tree.txt",
            selectionPaths: manifest.requestedPaths == nil ? nil : "index/selection.paths.txt",
            allPatch: availablePaths.contains("diff/all.patch") ? "diff/all.patch" : nil,
            deepHunks: availablePaths.contains("deep/hunks.jsonl") ? "deep/hunks.jsonl" : nil,
            deepChangedLines: availablePaths.contains("deep/changed_lines.tsv") ? "deep/changed_lines.tsv" : nil
        )
    }

    private nonisolated static func inlineDTO(
        mapText: String?,
        inlineMap: Bool,
        inlineMode: String,
        inlineMaxLines: Int
    ) -> Reply.InlineDTO? {
        guard inlineMap else { return nil }
        guard let mapText else { return nil }
        let sections = inlineMode == "brief" ? ["SNAPSHOT_META", "CHANGED_FILE_TREE"] : nil
        let excerpt = GitDiffMapBuilder.inlineExcerpt(
            from: mapText,
            maxLines: inlineMaxLines,
            sections: sections
        )
        return Reply.InlineDTO(
            mapExcerpt: excerpt.excerpt,
            truncated: excerpt.truncated,
            totalLines: excerpt.totalLines,
            returnedLines: excerpt.returnedLines
        )
    }

    private nonisolated static func primaryArtifactsDTO(
        snapshotDir: String,
        artifacts: Reply.ArtifactsDTO,
        manifest: GitDiffSnapshotManifest,
        autoSelectedPaths: [String]
    ) -> Reply.PrimaryArtifactsDTO {
        let primary = GitDiffSnapshotStore.primaryArtifacts(
            snapshotDir: snapshotDir,
            mapRelativePath: artifacts.map,
            allPatchRelativePath: artifacts.allPatch
        )
        let autoSelected = primary.selectionCandidates.filter(autoSelectedPaths.contains)
        let perFilePatches = GitDiffSnapshotStore.perFilePatchArtifacts(
            snapshotDir: snapshotDir,
            files: manifest.files
        ).map { patch in
            Reply.PrimaryArtifactsDTO.PerFilePatchDTO(
                jumpIndex: patch.jumpIndex,
                gitPath: patch.gitPath,
                selectionPath: patch.selectionPath,
                status: patch.status,
                additions: patch.additions,
                deletions: patch.deletions
            )
        }
        return Reply.PrimaryArtifactsDTO(
            map: primary.map,
            allPatch: primary.allPatch,
            autoSelected: autoSelected.isEmpty ? nil : autoSelected,
            perFilePatches: perFilePatches.isEmpty ? nil : perFilePatches
        )
    }
}
