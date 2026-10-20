// RPCE reply assembly; source category phases use captured formatting and token values.
// swiftlint:disable identifier_name implicit_optional_initialization function_body_length
import Foundation

// Source category phases share one reply-local counter set.
// swiftlint:disable:next type_body_length
enum RPCESelectionReplyAssembler {
    /// Metadata for user's actual preset settings (for virtual context state indicators)
    struct UserPresetState {
        let copyCodeMapUsage: String
        let chatCodeMapUsage: String
        /// Token count under user's copy preset settings (optional - computed lazily)
        var copyTokens: Int?
        /// Token count under user's chat preset settings (optional - computed lazily)
        var chatTokens: Int?
        /// What this reply uses (e.g. "auto" for virtual contexts)
        let normalizedCodeMapUsage: String
    }

    static func buildSelectedFilesReply(
        collections: SelectionCollections,
        formatter: PathFormatter,
        tokens: TokenServices,
        userPresetState: UserPresetState? = nil,
        copyUsage: CodeMapUsage? = nil,
        projection: CopyPresetProjectionConfig? = nil,
        entryResultsByFileID: [UUID: CapturedEntryResult]? = nil
    ) async -> ToolResultDTOs.SelectedFilesReply {
        let context = ReplyContext(collections: collections, formatter: formatter, tokens: tokens,
                                   userPresetState: userPresetState, copyUsage: copyUsage, projection: projection,
                                   entryResultsByFileID: entryResultsByFileID)
        var counts = ReplyCounts()
        for entry in collections.selected {
            await appendSelected(entry, context: context, counts: &counts)
        }
        for entry in collections.codemap {
            await appendCodemap(entry, context: context, counts: &counts)
        }
        return makeFilesReply(context: context, counts: counts)
    }

    private struct ReplyContext {
        let collections: SelectionCollections
        let formatter: PathFormatter
        let tokens: TokenServices
        let userPresetState: UserPresetState?
        let copyUsage: CodeMapUsage?
        let projection: CopyPresetProjectionConfig?
        let entryResultsByFileID: [UUID: CapturedEntryResult]?
    }

    private struct ReplyCounts {
        var files: [ToolResultDTOs.SelectedFileInfo] = []
        var fileSlices: [ToolResultDTOs.FileSliceDTO] = []
        var totalTokens = 0
        var copyTotalTokens = 0
        var copyContentTokens = 0
        var copyCodemapTokens = 0
        var fullCount = 0
        var sliceCount = 0
        var codemapCount = 0
        var fullTokens = 0
        var sliceTokens = 0
        var codemapTokens = 0
    }

    private static func appendSelected(_ entry: SelectedEntry, context: ReplyContext, counts: inout ReplyCounts) async {
        let collections = context.collections, formatter = context.formatter, tokens = context.tokens
        let copyUsage = context.copyUsage, entryResultsByFileID = context.entryResultsByFileID
        let file = entry.file
        let displayPath = await formatter.displayPath(for: file)
        let metadata = await pathMetadata(for: file, entry: entry.entry, formatter: formatter)
        let ranges = entry.ranges ?? []
        let hasSlices = !ranges.isEmpty
        let entryResult = entryResultsByFileID?[file.id]
        let tokenCount = if let entryResult {
            entryResult.displayTokens
        } else if hasSlices {
            await tokens.sliceTokens(for: entry.entry, ranges: ranges)
        } else {
            tokens.fullTokens(for: entry.entry)
        }

        counts.totalTokens += tokenCount
        if hasSlices {
            counts.sliceCount += 1
            counts.sliceTokens += tokenCount
            let dtoRanges = ranges.map { ToolResultDTOs.LineRangeDTO(range: $0) }
            counts.fileSlices.append(.init(
                path: displayPath,
                ranges: dtoRanges,
                rootPath: metadata.rootPath,
                pathWithinRoot: metadata.pathWithinRoot
            ))
        } else {
            counts.fullCount += 1
            counts.fullTokens += tokenCount
        }

        let rangesDTOs = hasSlices ? ranges.map { ToolResultDTOs.LineRangeDTO(range: $0) } : nil
        let autoRenderMode = hasSlices ? "slice" : "full"

        // Compute copy preset projection if copy usage differs from auto
        var copyPreset: ToolResultDTOs.SelectedFileInfo.CopyPresetProjection? = nil
        if let copyUsage, copyUsage != .auto {
            let codemapTokenCount = tokens.codemapTokens(
                for: file,
                codemapPresentation: collections.codemapPresentation
            )
            let hasCodemap = codemapTokenCount > 0
            copyPreset = computeCopyPresetProjection(
                autoRenderMode: autoRenderMode,
                autoTokens: tokenCount,
                hasCodemap: hasCodemap,
                copyUsage: copyUsage,
                codemapTokens: codemapTokenCount
            )
        }

        // Track copy total tokens and breakdown
        if let cp = copyPreset {
            counts.copyTotalTokens += cp.tokens
            // Track breakdown based on user preset render mode
            switch cp.renderMode {
            case "codemap":
                counts.copyCodemapTokens += cp.tokens
            case "hidden":
                break // 0 tokens, nothing to add
            default: // "full", "slice"
                counts.copyContentTokens += cp.tokens
            }
        } else {
            counts.copyTotalTokens += tokenCount
            counts.copyContentTokens += tokenCount // Original mode is content (full/slice)
        }

        counts.files.append(
            ToolResultDTOs.SelectedFileInfo(
                path: displayPath,
                tokens: tokenCount,
                renderMode: autoRenderMode,
                ranges: rangesDTOs,
                isAuto: false,
                codemapOrigin: nil,
                copyPreset: copyPreset,
                rootPath: metadata.rootPath,
                pathWithinRoot: metadata.pathWithinRoot
            )
        )
    }

    private static func appendCodemap(_ entry: CodemapEntry, context: ReplyContext, counts: inout ReplyCounts) async {
        let collections = context.collections, formatter = context.formatter, tokens = context.tokens
        let copyUsage = context.copyUsage
        let file = entry.file
        let displayPath = await formatter.displayPath(for: file)
        let metadata = await pathMetadata(for: file, entry: entry.entry, formatter: formatter)
        let rawCodemapTokens = tokens.codemapTokens(
            for: file,
            codemapPresentation: collections.codemapPresentation
        )
        let tokenCount = if rawCodemapTokens == 0, collections.codeMapUsage == .selected {
            tokens.fullTokens(for: entry.entry)
        } else {
            rawCodemapTokens
        }
        counts.codemapCount += 1
        counts.codemapTokens += tokenCount
        counts.totalTokens += tokenCount

        // For codemap counts.files, compute copy preset projection
        var copyPreset: ToolResultDTOs.SelectedFileInfo.CopyPresetProjection? = nil
        if let copyUsage, copyUsage != .auto {
            // Under 'none' or 'selected' mode, codemap-only counts.files wouldn't appear
            // Under 'complete' mode, same as auto for codemaps
            if copyUsage == .none || copyUsage == .selected {
                // Codemap-only counts.files wouldn't be included under 'none' or 'selected' mode
                // Mark as hidden (0 tokens, "hidden" mode)
                copyPreset = ToolResultDTOs.SelectedFileInfo.CopyPresetProjection(
                    tokens: 0,
                    renderMode: "hidden",
                    ranges: nil,
                    codemapOrigin: nil
                )
            }
            // For 'complete' mode, codemap stays as codemap (no projection needed)
        }

        // Track copy total tokens and breakdown (codemap-only counts.files under 'none' or 'selected' would be 0)
        if let copyUsage {
            if copyUsage == .none || copyUsage == .selected {
                // File wouldn't appear under copy preset
                // Don't add to counts.copyTotalTokens or breakdown
            } else {
                counts.copyTotalTokens += tokenCount
                counts.copyCodemapTokens += tokenCount
            }
        } else {
            counts.copyTotalTokens += tokenCount
            counts.copyCodemapTokens += tokenCount
        }

        counts.files.append(
            ToolResultDTOs.SelectedFileInfo(
                path: displayPath,
                tokens: tokenCount,
                renderMode: "codemap",
                ranges: nil,
                isAuto: entry.origin == .auto,
                codemapOrigin: entry.origin.rawValue,
                copyPreset: copyPreset,
                rootPath: metadata.rootPath,
                pathWithinRoot: metadata.pathWithinRoot
            )
        )
    }

    private static func makeFilesReply(
        context: ReplyContext, counts: ReplyCounts
    ) -> ToolResultDTOs.SelectedFilesReply {
        let collections = context.collections
        let userPresetState = context.userPresetState
        let copyUsage = context.copyUsage, projection = context.projection
        let summary = ToolResultDTOs.SelectionSummary(
            fullCount: counts.fullCount,
            sliceCount: counts.sliceCount,
            codemapCount: counts.codemapCount,
            fullTokens: counts.fullTokens,
            sliceTokens: counts.sliceTokens,
            codemapTokens: counts.codemapTokens
        )

        var reply = ToolResultDTOs.SelectedFilesReply(
            files: counts.files,
            totalTokens: counts.totalTokens,
            fileSlices: counts.fileSlices.isEmpty ? nil : counts.fileSlices,
            summary: summary,
            codeMapUsage: collections.codeMapUsage.rawValue
        )

        // Populate user preset state indicators if provided
        if let state = userPresetState {
            reply.userCopyCodeMapUsage = state.copyCodeMapUsage
            reply.userChatCodeMapUsage = state.chatCodeMapUsage
            // Use computed copy tokens if we have copy usage, otherwise use provided state
            reply.userCopyTokens = copyUsage != nil ? counts.copyTotalTokens : state.copyTokens
            reply.userChatTokens = state.chatTokens
            reply.normalizedCodeMapUsage = state.normalizedCodeMapUsage
            // Include user copy breakdown if we computed projections
            if copyUsage != nil {
                reply.userCopyContentTokens = counts.copyContentTokens
                reply.userCopyCodemapTokens = counts.copyCodemapTokens
            }
        } else if copyUsage != nil, copyUsage != .auto {
            // Even without full state, include copy tokens if we computed projections
            reply.userCopyCodeMapUsage = copyUsage?.rawValue
            reply.userCopyTokens = counts.copyTotalTokens
            reply.userCopyContentTokens = counts.copyContentTokens
            reply.userCopyCodemapTokens = counts.copyCodemapTokens
        }

        // Build copy preset projection summary if projection config is provided
        if let projection {
            // Compute projected tokens based on includeFiles flag
            let projectedTokens: Int = if !projection.includeFiles {
                // Files not included - only codemaps if mode supports them
                projection.codeMapUsage == .none ? 0 : counts.codemapTokens
            } else {
                // Use the computed copy total tokens
                counts.copyTotalTokens
            }
            reply.copyPresetProjection = ToolResultDTOs.CopyPresetProjectionSummaryDTO(
                codeMapUsage: projection.codeMapUsage.rawValue,
                includesFiles: projection.includeFiles,
                totalTokens: projectedTokens
            )
        }

        return reply
    }

    /// Post-filter a SelectionReply for "codemaps" view.
    static func applyViewFilter(_ reply: ToolResultDTOs.SelectionReply, view: String) -> ToolResultDTOs.SelectionReply {
        guard view == "codemaps", let files = reply.files else { return reply }

        let filteredFiles = files.filter { $0.renderMode == "codemap" }
        let filteredPaths = Set(filteredFiles.map(\.path))
        let filteredSlices = reply.fileSlices?.filter { filteredPaths.contains($0.path) }
        let totalTokens = filteredFiles.reduce(0) { $0 + $1.tokens }

        // Recompute a minimal summary for the filtered view to avoid confusing totals
        let summary = ToolResultDTOs.SelectionSummary(
            fullCount: 0,
            sliceCount: 0,
            codemapCount: filteredFiles.count,
            fullTokens: 0,
            sliceTokens: 0,
            codemapTokens: totalTokens
        )

        return ToolResultDTOs.SelectionReply(
            files: filteredFiles,
            totalTokens: totalTokens,
            status: reply.status,
            invalidPaths: reply.invalidPaths,
            // No content blocks for codemaps view
            blocks: nil,
            codeStructure: reply.codeStructure,
            fileSlices: filteredSlices,
            codemapAutoEnabled: reply.codemapAutoEnabled,
            summary: summary,
            codeMapUsage: reply.codeMapUsage,
            // Preserve user preset state indicators
            userCopyCodeMapUsage: reply.userCopyCodeMapUsage,
            userChatCodeMapUsage: reply.userChatCodeMapUsage,
            userCopyTokens: reply.userCopyTokens,
            userChatTokens: reply.userChatTokens,
            normalizedCodeMapUsage: reply.normalizedCodeMapUsage,
            // Preserve workspace token stats (total breakdown stays the same even for filtered view)
            tokenStats: reply.tokenStats,
            tokenAccounting: reply.tokenAccounting,
            copyPresetProjection: reply.copyPresetProjection
        )
    }
}

// swiftlint:enable identifier_name implicit_optional_initialization function_body_length
