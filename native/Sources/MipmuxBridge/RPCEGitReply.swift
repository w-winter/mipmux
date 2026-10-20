// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
// swiftlint:disable nesting type_body_length file_length identifier_name
import Foundation

struct RPCEGitReply: Codable, Equatable {
    let op: String

    /// Multi-root support
    /// Per-repo results for multi-root operations (nil when single repo)
    let repos: [RepoResultDTO]?
    /// Aggregated results across all repos (for multi-root diff operations)
    let aggregate: AggregateDTO?

    /// Status op payload (single repo)
    let status: StatusDTO?

    /// Diff op payload (single repo)
    let diff: DiffDTO?

    /// Log op payload (single repo)
    let log: LogDTO?

    /// Show op payload (single repo)
    let show: ShowDTO?

    /// Blame op payload (single repo)
    let blame: BlameDTO?

    /// Worktree metadata (single repo)
    let worktree: WorktreeDTO?

    // Artifact info (diff with artifacts: true)
    let snapshotId: String?
    let snapshotDir: String?

    let artifacts: ArtifactsDTO?
    let primaryArtifacts: PrimaryArtifactsDTO?
    let summary: SummaryDTO?
    let oneliner: String?
    let inputs: DiffInputsDTO?
    let modeDetails: String?
    let inline: InlineDTO?

    // Common
    let warning: String?
    let emptyReason: String?
    let error: String?

    private enum CodingKeys: String, CodingKey {
        case op, repos, aggregate, status, diff, log, show, blame, worktree
        case artifacts, summary, oneliner, inputs, inline, warning, error
        case primaryArtifacts = "primary_artifacts"
        case snapshotId = "snapshot_id"
        case snapshotDir = "snapshot_dir"

        case modeDetails = "mode_details"
        case emptyReason = "empty_reason"
    }

    /// Optional operation payloads are omitted from encoded replies.
    init(
        op: String,
        repos: [RepoResultDTO]? = nil,
        aggregate: AggregateDTO? = nil,
        status: StatusDTO? = nil,
        diff: DiffDTO? = nil,
        log: LogDTO? = nil,
        show: ShowDTO? = nil,
        blame: BlameDTO? = nil,
        worktree: WorktreeDTO? = nil,
        snapshotId: String? = nil,
        snapshotDir: String? = nil,
        artifacts: ArtifactsDTO? = nil,
        primaryArtifacts: PrimaryArtifactsDTO? = nil,
        summary: SummaryDTO? = nil,
        oneliner: String? = nil,
        inputs: DiffInputsDTO? = nil,
        modeDetails: String? = nil,
        inline: InlineDTO? = nil,
        warning: String? = nil,
        emptyReason: String? = nil,
        error: String? = nil
    ) {
        self.op = op
        self.repos = repos
        self.aggregate = aggregate
        self.status = status
        self.diff = diff
        self.log = log
        self.show = show
        self.blame = blame
        self.worktree = worktree
        self.snapshotId = snapshotId
        self.snapshotDir = snapshotDir
        self.artifacts = artifacts
        self.primaryArtifacts = primaryArtifacts
        self.summary = summary
        self.oneliner = oneliner
        self.inputs = inputs
        self.modeDetails = modeDetails
        self.inline = inline
        self.warning = warning
        self.emptyReason = emptyReason
        self.error = error
    }

    // MARK: - Nested DTOs

    // MARK: Multi-root DTOs

    /// Per-repo result for multi-root operations
    struct RepoResultDTO: Codable, Equatable {
        /// Canonical absolute path of the git repository root
        let repoRoot: String
        /// Stable repo key for storage/identification
        let repoKey: String
        /// Human-readable repo name (typically last path component)
        let repoName: String?

        // Op-specific payloads (at most one populated per repo)
        let status: StatusDTO?
        let diff: DiffDTO?
        let log: LogDTO?
        let show: ShowDTO?
        let blame: BlameDTO?

        /// Worktree metadata (per repo)
        let worktree: WorktreeDTO?

        // Artifact info (for diff with artifacts)
        let snapshotId: String?
        let snapshotDir: String?
        let artifacts: ArtifactsDTO?
        let primaryArtifacts: PrimaryArtifactsDTO?
        let summary: SummaryDTO?
        let oneliner: String?
        let inputs: DiffInputsDTO?
        let modeDetails: String?
        let inline: InlineDTO?

        // Per-repo status
        let warning: String?
        let emptyReason: String?
        let error: String?

        private enum CodingKeys: String, CodingKey {
            case repoRoot = "repo_root"
            case repoKey = "repo_key"
            case repoName = "repo_name"
            case status, diff, log, show, blame, worktree
            case snapshotId = "snapshot_id"
            case snapshotDir = "snapshot_dir"
            case artifacts, summary, oneliner, inputs
            case primaryArtifacts = "primary_artifacts"
            case modeDetails = "mode_details"
            case inline
            case warning
            case emptyReason = "empty_reason"
            case error
        }

        init(
            repoRoot: String,
            repoKey: String,
            repoName: String? = nil,
            status: StatusDTO? = nil,
            diff: DiffDTO? = nil,
            log: LogDTO? = nil,
            show: ShowDTO? = nil,
            blame: BlameDTO? = nil,
            worktree: WorktreeDTO? = nil,
            snapshotId: String? = nil,
            snapshotDir: String? = nil,
            artifacts: ArtifactsDTO? = nil,
            primaryArtifacts: PrimaryArtifactsDTO? = nil,
            summary: SummaryDTO? = nil,
            oneliner: String? = nil,
            inputs: DiffInputsDTO? = nil,
            modeDetails: String? = nil,
            inline: InlineDTO? = nil,
            warning: String? = nil,
            emptyReason: String? = nil,
            error: String? = nil
        ) {
            self.repoRoot = repoRoot
            self.repoKey = repoKey
            self.repoName = repoName
            self.status = status
            self.diff = diff
            self.log = log
            self.show = show
            self.blame = blame
            self.worktree = worktree
            self.snapshotId = snapshotId
            self.snapshotDir = snapshotDir
            self.artifacts = artifacts
            self.primaryArtifacts = primaryArtifacts
            self.summary = summary
            self.oneliner = oneliner
            self.inputs = inputs
            self.modeDetails = modeDetails
            self.inline = inline
            self.warning = warning
            self.emptyReason = emptyReason
            self.error = error
        }
    }

    /// Aggregated results across multiple repos (for multi-root diff)
    struct AggregateDTO: Codable, Equatable {
        /// Combined totals across all repos
        let totals: TotalsDTO?
        /// Combined status breakdown across all repos
        let byStatus: [String: Int]?
        /// Summary one-liner (e.g., "3 repos: 15 files (+200 -50)")
        let oneliner: String?
        /// Number of repos included in aggregation
        let repoCount: Int?

        init(
            totals: TotalsDTO? = nil,
            byStatus: [String: Int]? = nil,
            oneliner: String? = nil,
            repoCount: Int? = nil
        ) {
            self.totals = totals
            self.byStatus = byStatus
            self.oneliner = oneliner
            self.repoCount = repoCount
        }

        private enum CodingKeys: String, CodingKey {
            case totals
            case byStatus = "by_status"
            case oneliner
            case repoCount = "repo_count"
        }
    }

    struct WorktreeDTO: Codable, Equatable {
        let isWorktree: Bool
        let worktreeName: String?
        let worktreeRoot: String
        let commonGitDir: String?
        let mainWorktreeRoot: String?
        let worktreeBranch: String?
        let mainBranch: String?
        let worktreeHead: String?
        let mainHead: String?

        private enum CodingKeys: String, CodingKey {
            case isWorktree = "is_worktree"
            case worktreeName = "worktree_name"
            case worktreeRoot = "worktree_root"
            case commonGitDir = "common_git_dir"
            case mainWorktreeRoot = "main_worktree_root"
            case worktreeBranch = "worktree_branch"
            case mainBranch = "main_branch"
            case worktreeHead = "worktree_head"
            case mainHead = "main_head"
        }
    }

    typealias StatusDTO = RPCEGitStatus.StatusDTO

    typealias DiffDTO = RPCEGitProjection.DiffDTO

    typealias DiffFileDTO = RPCEGitProjection.DiffFileDTO

    typealias DiffHunkDTO = RPCEGitProjection.DiffHunkDTO

    typealias TotalsDTO = RPCEGitProjection.TotalsDTO

    struct LogDTO: Codable, Equatable {
        let commits: [CommitSummaryDTO]
    }

    struct CommitSummaryDTO: Codable, Equatable {
        let sha: String
        let shortSha: String
        let author: String
        let date: String
        let message: String
        let filesChanged: Int
        let insertions: Int
        let deletions: Int

        private enum CodingKeys: String, CodingKey {
            case sha, author, date, message, insertions, deletions
            case shortSha = "short_sha"
            case filesChanged = "files_changed"
        }
    }

    typealias ShowDTO = RPCEGitProjection.ShowDTO

    struct BlameDTO: Codable, Equatable {
        let path: String
        let lines: [BlameLineDTO]
    }

    struct BlameLineDTO: Codable, Equatable {
        let num: Int
        let sha: String
        let author: String
        let date: String
        let content: String
    }

    struct SummaryDTO: Codable, Equatable {
        let files: Int
        let insertions: Int
        let deletions: Int
        let byStatus: [String: Int]?

        private enum CodingKeys: String, CodingKey {
            case files, insertions, deletions
            case byStatus = "by_status"
        }
    }

    struct ArtifactsDTO: Codable, Equatable {
        let manifest: String
        let map: String
        let filesTsv: String
        let changedLines: String?
        let tree: String
        let selectionPaths: String?
        let allPatch: String?
        let deepHunks: String?
        let deepChangedLines: String?

        private enum CodingKeys: String, CodingKey {
            case manifest, map, tree
            case filesTsv = "files_tsv"
            case changedLines = "changed_lines"
            case selectionPaths = "selection_paths"
            case allPatch = "all_patch"
            case deepHunks = "deep_hunks"
            case deepChangedLines = "deep_changed_lines"
        }
    }

    struct PrimaryArtifactsDTO: Codable, Equatable {
        struct PerFilePatchDTO: Codable, Equatable {
            let jumpIndex: Int
            let gitPath: String
            let selectionPath: String
            let status: String?
            let additions: Int?
            let deletions: Int?

            private enum CodingKeys: String, CodingKey {
                case status, additions, deletions
                case jumpIndex = "jump_index"
                case gitPath = "git_path"
                case selectionPath = "selection_path"
            }
        }

        let map: String
        let allPatch: String?
        let autoSelected: [String]?
        let perFilePatches: [PerFilePatchDTO]?

        private enum CodingKeys: String, CodingKey {
            case map
            case allPatch = "all_patch"
            case autoSelected = "auto_selected"
            case perFilePatches = "per_file_patches"
        }
    }

    struct InlineDTO: Codable, Equatable {
        let mapExcerpt: String
        let truncated: Bool
        let totalLines: Int
        let returnedLines: Int

        private enum CodingKeys: String, CodingKey {
            case mapExcerpt = "map_excerpt"
            case truncated
            case totalLines = "total_lines"
            case returnedLines = "returned_lines"
        }
    }

    struct DiffInputsDTO: Codable, Equatable {
        let compare: String
        let compareInput: String?
        let scope: String
        let requestedPathsCount: Int?
        let contextLines: Int
        let detectRenames: Bool

        private enum CodingKeys: String, CodingKey {
            case compare, scope
            case compareInput = "compare_input"
            case requestedPathsCount = "requested_paths_count"
            case contextLines = "context_lines"
            case detectRenames = "detect_renames"
        }
    }
}

// swiftlint:enable nesting type_body_length file_length identifier_name
