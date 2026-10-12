// RPCE projection policy; values are supplied by the captured reply context.
import Foundation

extension RPCESelectionReplyAssembler {
    /// Computes how a file would render under a given codemap usage mode
    static func computeCopyPresetProjection(
        autoRenderMode: String,
        autoTokens: Int,
        hasCodemap: Bool,
        copyUsage: CodeMapUsage,
        codemapTokens: Int
    ) -> ToolResultDTOs.SelectedFileInfo.CopyPresetProjection? {
        // Determine what renderMode would be under copy preset
        let copyRenderMode: String
        let copyTokens: Int
        let copyOrigin: String?

        switch copyUsage {
        case .auto:
            // Same as auto view - no projection needed
            return nil

        case .selected:
            // Full/slice files with codemaps become codemaps
            if autoRenderMode == "full" || autoRenderMode == "slice", hasCodemap {
                copyRenderMode = "codemap"
                copyTokens = codemapTokens
                copyOrigin = "selected_mode"
            } else if autoRenderMode == "codemap" {
                // Already codemap, no change
                return nil
            } else {
                // No codemap available, stays as is
                return nil
            }

        case .complete:
            // Everything with a codemap becomes codemap
            if hasCodemap, autoRenderMode != "codemap" {
                copyRenderMode = "codemap"
                copyTokens = codemapTokens
                copyOrigin = "complete_mode"
            } else {
                return nil
            }

        case .none:
            // Under 'none' mode, codemaps are disabled
            if autoRenderMode == "codemap" {
                // Codemap-only files wouldn't appear - mark as hidden
                return ToolResultDTOs.SelectedFileInfo.CopyPresetProjection(
                    tokens: 0,
                    renderMode: "hidden",
                    ranges: nil,
                    codemapOrigin: nil
                )
            } else {
                // Full/slice stays the same
                return nil
            }
        }

        // Only return projection if it differs from auto view
        if copyRenderMode == autoRenderMode, copyTokens == autoTokens {
            return nil
        }

        return ToolResultDTOs.SelectedFileInfo.CopyPresetProjection(
            tokens: copyTokens,
            renderMode: copyRenderMode,
            ranges: nil,
            codemapOrigin: copyOrigin
        )
    }
}
