// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation

// Modified: retain the Standard/Review declarations and their referenced UUIDs.
enum BuiltInCopyPresets {
    private static let reviewPromptId = UUID(uuidString: "D7F1B2E4-3C5A-6B8D-CF8E-1F5D0E2A4C6B")!
    private static let standardUUID = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
    private static let codeReviewUUID = UUID(uuidString: "66666666-6666-6666-6666-666666666666")!
    /// Standard preset - Default balanced configuration
    static let standard = CopyPreset(
        id: standardUUID,
        name: "Standard",
        builtInKind: .standard,
        description: "Balanced configuration for general use",
        icon: "📄",
        isBuiltIn: true,
        includeFiles: true,
        includeUserPrompt: true,
        includeMetaPrompts: false, // No stored prompts
        includeFileTree: true,
        fileTreeMode: .auto,
        codeMapUsage: .auto,
        gitInclusion: GitInclusion.none,
        storedPromptIds: [] // No stored prompts
    )
    /// Code Review preset - Review with git diff
    static let codeReview = CopyPreset(
        id: codeReviewUUID,
        name: "Review",
        builtInKind: .codeReview,
        description: "Thorough code review focusing on quality and regressions",
        icon: "🔍",
        isBuiltIn: true,
        includeFiles: true,
        includeUserPrompt: true,
        includeMetaPrompts: true,
        includeFileTree: true,
        fileTreeMode: .auto,
        codeMapUsage: .auto,
        gitInclusion: .selected, // Include git diff for review
        storedPromptIds: [reviewPromptId] // Reference the [Review] stored prompt
    )
}
