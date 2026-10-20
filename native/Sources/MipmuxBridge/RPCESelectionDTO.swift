// RPCE selection DTOs retain their names, nesting and explicit nil initializers.
// swiftlint:disable nesting implicit_optional_initialization
import Foundation

extension ToolResultDTOs {
    struct SelectedCodeStructureDTO: Codable, Equatable {
        let fileCount: Int
        let content: String
        /// Paths (display-form) that are selected but have **no codemap** available
        let unmappedPaths: [String]?
        /// Paths still awaiting a codemap after repair scheduling
        let pendingPaths: [String]?
        /// Number of additional files with codemaps omitted due to `max_results` cap
        let omittedCount: Int?
        /// Total number of codemaps omitted due to all limits
        let omittedTotal: Int?
        /// Number of codemaps omitted due to the response token budget
        let tokenBudgetOmittedCount: Int?
        /// Indicates the response token budget prevented more codemaps from being emitted
        let tokenBudgetHit: Bool?
        let worktreeScope: WorktreeScopeDTO?

        init(
            fileCount: Int,
            content: String,
            unmappedPaths: [String]? = nil,
            pendingPaths: [String]? = nil,
            omittedCount: Int? = nil,
            omittedTotal: Int? = nil,
            tokenBudgetOmittedCount: Int? = nil,
            tokenBudgetHit: Bool? = nil,
            worktreeScope: WorktreeScopeDTO? = nil
        ) {
            self.fileCount = fileCount
            self.content = content
            self.unmappedPaths = unmappedPaths
            self.pendingPaths = pendingPaths
            self.omittedCount = omittedCount
            self.omittedTotal = omittedTotal
            self.tokenBudgetOmittedCount = tokenBudgetOmittedCount
            self.tokenBudgetHit = tokenBudgetHit
            self.worktreeScope = worktreeScope
        }

        private enum CodingKeys: String, CodingKey {
            case fileCount = "file_count"
            case content
            case unmappedPaths = "unmapped_paths"
            case pendingPaths = "pending_paths"
            case omittedCount = "codemaps_omitted"
            case omittedTotal = "omitted_total"
            case tokenBudgetOmittedCount = "token_budget_omitted"
            case tokenBudgetHit = "token_budget_hit"
            case worktreeScope = "worktree_scope"
        }
    }

    struct LineRangeDTO: Codable, Equatable {
        let startLine: Int
        let endLine: Int
        /// Optional description explaining what this slice contains and why it's relevant
        let description: String?

        init(startLine: Int, endLine: Int, description: String? = nil) {
            self.startLine = startLine
            self.endLine = endLine
            self.description = description
        }

        init(range: LineRange) {
            self.init(startLine: range.start, endLine: range.end, description: range.description)
        }

        private enum CodingKeys: String, CodingKey {
            case startLine = "start_line"
            case endLine = "end_line"
            case description
        }
    }

    struct FileSliceDTO: Codable, Equatable {
        let path: String
        let ranges: [LineRangeDTO]
        /// Absolute workspace/root path for markdown grouping. `path` remains the requested display path.
        let rootPath: String?
        /// File path relative to `rootPath`, used for markdown tree rendering.
        let pathWithinRoot: String?

        init(
            path: String,
            ranges: [LineRangeDTO],
            rootPath: String? = nil,
            pathWithinRoot: String? = nil
        ) {
            self.path = path
            self.ranges = ranges
            self.rootPath = rootPath
            self.pathWithinRoot = pathWithinRoot
        }

        private enum CodingKeys: String, CodingKey {
            case path
            case ranges
            case rootPath = "root_path"
            case pathWithinRoot = "path_within_root"
        }
    }

    struct SelectedFileInfo: Codable, Equatable {
        /// How a file would render under the user's copy preset (when different from auto view)
        struct CopyPresetProjection: Codable, Equatable {
            let tokens: Int
            let renderMode: String // "full" | "slice" | "codemap" | "hidden"
            let ranges: [LineRangeDTO]? // for slice
            let codemapOrigin: String? // if codemap: "selected_mode", etc.

            private enum CodingKeys: String, CodingKey {
                case tokens
                case renderMode = "render_mode"
                case ranges
                case codemapOrigin = "codemap_origin"
            }
        }

        let path: String
        let tokens: Int
        let renderMode: String
        let ranges: [LineRangeDTO]?
        let isAuto: Bool
        /// Why this file is rendered as a codemap: "auto", "manual", or "selected_mode". Nil for non-codemap files.
        let codemapOrigin: String?
        /// How this file would render under the user's copy preset (only set when it differs from auto view)
        let copyPreset: CopyPresetProjection?
        /// Absolute workspace/root path for markdown grouping. `path` remains the requested display path.
        let rootPath: String?
        /// File path relative to `rootPath`, used for markdown tree rendering.
        let pathWithinRoot: String?

        init(
            path: String,
            tokens: Int,
            renderMode: String,
            ranges: [LineRangeDTO]?,
            isAuto: Bool,
            codemapOrigin: String?,
            copyPreset: CopyPresetProjection?,
            rootPath: String? = nil,
            pathWithinRoot: String? = nil
        ) {
            self.path = path
            self.tokens = tokens
            self.renderMode = renderMode
            self.ranges = ranges
            self.isAuto = isAuto
            self.codemapOrigin = codemapOrigin
            self.copyPreset = copyPreset
            self.rootPath = rootPath
            self.pathWithinRoot = pathWithinRoot
        }

        private enum CodingKeys: String, CodingKey {
            case path
            case tokens
            case renderMode = "render_mode"
            case ranges
            case isAuto = "is_auto"
            case codemapOrigin = "codemap_origin"
            case copyPreset = "copy_preset"
            case rootPath = "root_path"
            case pathWithinRoot = "path_within_root"
        }
    }

    struct SelectionSummary: Codable, Equatable {
        let fullCount: Int
        let sliceCount: Int
        let codemapCount: Int
        let fullTokens: Int
        let sliceTokens: Int
        let codemapTokens: Int

        private enum CodingKeys: String, CodingKey {
            case fullCount = "full_count"
            case sliceCount = "slice_count"
            case codemapCount = "codemap_count"
            case fullTokens = "full_tokens"
            case sliceTokens = "slice_tokens"
            case codemapTokens = "codemap_tokens"
        }
    }

    struct SelectedFilesReply: Codable, Equatable {
        let files: [SelectedFileInfo]
        let totalTokens: Int
        let fileSlices: [FileSliceDTO]?
        let summary: SelectionSummary?
        /// The active codemap usage mode: "auto", "complete", "selected", or "none"
        var codeMapUsage: String? = nil

        // MARK: - User Preset State Indicators (for virtual contexts)

        /// User's copy preset codemap mode (so builder knows user's actual view)
        var userCopyCodeMapUsage: String? = nil
        /// User's chat preset codemap mode
        var userChatCodeMapUsage: String? = nil
        /// Token count under user's copy preset settings
        var userCopyTokens: Int? = nil
        /// Token count under user's chat preset settings
        var userChatTokens: Int? = nil
        /// What this reply uses (e.g. "auto" for virtual contexts, nil if live)
        var normalizedCodeMapUsage: String? = nil
        /// Summary of how selection would render under the effective copy preset (when it differs from auto)
        var copyPresetProjection: CopyPresetProjectionSummaryDTO? = nil
        /// Content tokens (full + slice) under user's copy preset settings
        var userCopyContentTokens: Int? = nil
        /// Codemap tokens under user's copy preset settings (0 when codemaps disabled)
        var userCopyCodemapTokens: Int? = nil

        private enum CodingKeys: String, CodingKey {
            case files
            case totalTokens = "total_tokens"
            case fileSlices = "file_slices"
            case summary
            case codeMapUsage = "code_map_usage"
            case userCopyCodeMapUsage = "user_copy_codemap_usage"
            case userChatCodeMapUsage = "user_chat_codemap_usage"
            case userCopyTokens = "user_copy_tokens"
            case userChatTokens = "user_chat_tokens"
            case normalizedCodeMapUsage = "normalized_codemap_usage"
            case copyPresetProjection = "copy_preset_projection"
            case userCopyContentTokens = "user_copy_content_tokens"
            case userCopyCodemapTokens = "user_copy_codemap_tokens"
        }
    }

    struct SelectionReply: Codable, Equatable {
        let files: [SelectedFileInfo]?
        let totalTokens: Int?
        let status: String
        let invalidPaths: [String]?
        /// When `manage_selection` action=`list` and `include_content=true`
        let blocks: [String]?
        /// Compact code-map summary for the current selection (no large content)
        let codeStructure: SelectedCodeStructureDTO?
        let fileSlices: [FileSliceDTO]?
        let codemapAutoEnabled: Bool?
        let summary: SelectionSummary?
        /// The active codemap usage mode: "auto", "complete", "selected", or "none"
        let codeMapUsage: String?

        // MARK: - User Preset State Indicators (for virtual contexts)

        /// User's copy preset codemap mode (so builder knows user's actual view)
        let userCopyCodeMapUsage: String?
        /// User's chat preset codemap mode
        let userChatCodeMapUsage: String?
        /// Token count under user's copy preset settings
        let userCopyTokens: Int?
        /// Token count under user's chat preset settings
        let userChatTokens: Int?
        /// What this reply uses (e.g. "auto" for virtual contexts, nil if live)
        let normalizedCodeMapUsage: String?
        /// Workspace token breakdown (total includes prompt, file tree, meta, git, etc.)
        let tokenStats: TokenStats?
        /// Cache freshness and pending refresh state for token fields.
        let tokenAccounting: TokenAccountingDTO?
        /// Summary of how selection would render under the effective copy preset (when it differs from auto)
        let copyPresetProjection: CopyPresetProjectionSummaryDTO?

        /// Explicit initializer with tokenStats defaulting to nil for source compatibility
        init(
            files: [SelectedFileInfo]?,
            totalTokens: Int?,
            status: String,
            invalidPaths: [String]? = nil,
            blocks: [String]? = nil,
            codeStructure: SelectedCodeStructureDTO? = nil,
            fileSlices: [FileSliceDTO]? = nil,
            codemapAutoEnabled: Bool? = nil,
            summary: SelectionSummary? = nil,
            codeMapUsage: String? = nil,
            userCopyCodeMapUsage: String? = nil,
            userChatCodeMapUsage: String? = nil,
            userCopyTokens: Int? = nil,
            userChatTokens: Int? = nil,
            normalizedCodeMapUsage: String? = nil,
            tokenStats: TokenStats? = nil,
            tokenAccounting: TokenAccountingDTO? = nil,
            copyPresetProjection: CopyPresetProjectionSummaryDTO? = nil
        ) {
            self.files = files
            self.totalTokens = totalTokens
            self.status = status
            self.invalidPaths = invalidPaths
            self.blocks = blocks
            self.codeStructure = codeStructure
            self.fileSlices = fileSlices
            self.codemapAutoEnabled = codemapAutoEnabled
            self.summary = summary
            self.codeMapUsage = codeMapUsage
            self.userCopyCodeMapUsage = userCopyCodeMapUsage
            self.userChatCodeMapUsage = userChatCodeMapUsage
            self.userCopyTokens = userCopyTokens
            self.userChatTokens = userChatTokens
            self.normalizedCodeMapUsage = normalizedCodeMapUsage
            self.tokenStats = tokenStats
            self.tokenAccounting = tokenAccounting
            self.copyPresetProjection = copyPresetProjection
        }

        private enum CodingKeys: String, CodingKey {
            case files
            case totalTokens = "total_tokens"
            case status
            case invalidPaths = "invalid_paths"
            case blocks
            case codeStructure = "code_structure"
            case fileSlices = "file_slices"
            case codemapAutoEnabled = "codemap_auto_enabled"
            case summary
            case codeMapUsage = "code_map_usage"
            case userCopyCodeMapUsage = "user_copy_codemap_usage"
            case userChatCodeMapUsage = "user_chat_codemap_usage"
            case userCopyTokens = "user_copy_tokens"
            case userChatTokens = "user_chat_tokens"
            case normalizedCodeMapUsage = "normalized_codemap_usage"
            case tokenStats = "token_stats"
            case tokenAccounting = "token_accounting"
            case copyPresetProjection = "copy_preset_projection"
        }
    }
}

// swiftlint:enable nesting implicit_optional_initialization
