// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
import Foundation

// Modified: retain the supported preset declarations and their referenced UUIDs.
enum BuiltInCopyPresets {
    private static let standardUUID = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
    private static let manualUUID = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
    private static let diffFollowUpUUID = UUID(uuidString: "55555555-5555-5555-5555-555555555555")!
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
        includeFileTree: true,
        fileTreeMode: .auto,
        codeMapUsage: .auto,
        gitInclusion: GitInclusion.none)
    /// Manual preset - Full control (uses current UI state)
    static let manual = CopyPreset(
        id: manualUUID,
        name: "Manual",
        builtInKind: .manual,
        description: "Full control - use current settings",
        icon: "⚙️",
        isBuiltIn: true,
        includeFiles: nil, // All nil = use current UI state
        includeUserPrompt: nil,
        includeFileTree: nil,
        fileTreeMode: nil,
        codeMapUsage: nil,
        gitInclusion: nil // nil = use current UI state
    )
    /// Diff Follow-Up preset - Git-only context for follow-up discussions
    static let diffFollowUp = CopyPreset(
        id: diffFollowUpUUID,
        name: "Diff Follow-Up",
        builtInKind: .diffFollowUp,
        description: "Git diff only - discuss recent changes",
        icon: "↪︎",
        isBuiltIn: true,
        includeFiles: false, // No files
        includeUserPrompt: true, // Include user instructions
        includeFileTree: false,
        fileTreeMode: FileTreeOption.none,
        codeMapUsage: CodeMapUsage.none,
        gitInclusion: .selected // Git diff is the focus
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
        includeFileTree: true,
        fileTreeMode: .auto,
        codeMapUsage: .auto,
        gitInclusion: .selected // Include git diff for review
    )
}
