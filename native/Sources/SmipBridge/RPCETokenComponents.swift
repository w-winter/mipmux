// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct TokenComponentBreakdown {
    let prompt: Int
    let duplicatePrompt: Int
    let instructions: Int
    let fileTree: Int
    let gitDiff: Int
    let metadata: Int

    var promptDisplay: Int {
        prompt + duplicatePrompt
    }

    var other: Int {
        metadata
    }

    var totalNonFile: Int {
        prompt + duplicatePrompt + instructions + fileTree + gitDiff + metadata
    }
}

extension TokenCalculationService {
    // swiftlint:disable:next function_parameter_count
    static func calculateComponentBreakdown(
        promptText: String,
        selectedInstructionsText: String,
        fileTreeText: String,
        gitDiffText: String?,
        metadataText: String?,
        duplicateUserInstructionsAtTop: Bool
    ) -> TokenComponentBreakdown {
        let promptTokens = estimateTokens(for: promptText)
        let duplicatePromptTokens = duplicateUserInstructionsAtTop ? promptTokens : 0
        let instructionsTokens = estimateTokens(for: selectedInstructionsText)
        let fileTreeTokens = fileTreeText.isEmpty ? 0 : estimateTokens(for: fileTreeText)
        let gitDiffTokens = gitDiffText.map(estimateTokens(for:)) ?? 0
        let metadataTokens = metadataText.map(estimateTokens(for:)) ?? 0
        return TokenComponentBreakdown(
            prompt: promptTokens,
            duplicatePrompt: duplicatePromptTokens,
            instructions: instructionsTokens,
            fileTree: fileTreeTokens,
            gitDiff: gitDiffTokens,
            metadata: metadataTokens
        )
    }
}

enum RPCETokenStats {
    static func makeTokenStats(
        filesTokens: Int,
        filesContentTokens: Int? = nil,
        codemapsTokens: Int? = nil,
        breakdown: TokenComponentBreakdown
    ) -> ToolResultDTOs.TokenStats {
        let promptTokens = breakdown.promptDisplay
        let metaTokens = breakdown.instructions
        let treeTokens = breakdown.fileTree
        let gitTokens = breakdown.gitDiff
        let otherTokens = breakdown.other
        return .init(
            total: filesTokens + breakdown.totalNonFile,
            files: filesTokens,
            prompt: promptTokens > 0 ? promptTokens : nil,
            fileTree: treeTokens > 0 ? treeTokens : nil,
            meta: metaTokens > 0 ? metaTokens : nil,
            git: gitTokens > 0 ? gitTokens : nil,
            other: otherTokens > 0 ? otherTokens : nil,
            filesContent: filesContentTokens,
            codemaps: codemapsTokens
        )
    }
}
