// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: captured settings replace the app view model; resolver methods retain their original bodies.
import Foundation

struct PromptContextResolved {
    var includeFiles: Bool
    var includeUserPrompt: Bool
    var includeMetaPrompts: Bool
    var includeFileTree: Bool
    var fileTreeMode: FileTreeOption
    var codeMapUsage: CodeMapUsage
    var gitInclusion: GitInclusion
    var storedPromptIds: [UUID]?
}
struct CopyCustomizations: Decodable {
    let includeFiles: Bool?
    let includeUserPrompt: Bool?
    let includeMetaPrompts: Bool?
    let includeFileTree: Bool?
    let fileTreeMode: FileTreeOption?
    let codeMapUsage: CodeMapUsage?
    let gitInclusion: GitInclusion?
}
enum GitDiffInclusionMode: String, Decodable { case none, selectedFiles, all }
struct CapturedGitSettings: Decodable { let gitDiffInclusionMode: GitDiffInclusionMode }
struct CapturedCopySettings: Decodable {
    struct Current: Decodable {
        let fileTreeMode: FileTreeOption
        let codeMapUsage: CodeMapUsage
        let gitInclusion: GitDiffInclusionMode
    }
    let kind: String
    let current: Current
    let customizations: CopyCustomizations
    let codeMapsGloballyDisabled: Bool
    let selectedPromptIds: [UUID]
    let activeGitRoot: String?
}
struct ClipboardPresetResolver {
    let fileTreeOption: FileTreeOption
    let codeMapUsage: CodeMapUsage
    let codeMapsGloballyDisabled: Bool
    let gitViewModel: CapturedGitSettings
    nonisolated static func resolveCopyCodeMapUsage(
        isManualPreset: Bool,
        customCodeMapUsage: CodeMapUsage?,
        presetCodeMapUsage: CodeMapUsage?,
        uiCodeMapUsage: CodeMapUsage,
        globallyDisabled: Bool = false
    ) -> CodeMapUsage {
        guard !globallyDisabled else { return .none }
        if isManualPreset {
            return uiCodeMapUsage
        }
        return presetCodeMapUsage ?? uiCodeMapUsage
    }
    func resolvePromptContext(_ preset: CopyPreset, custom: CopyCustomizations?) -> PromptContextResolved {
        // Manual preset is the only place where per-workspace overrides apply
        let isManualPreset = (preset.builtInKind == .manual) || (preset.id == BuiltInCopyPresets.manual.id)
        let effectiveCustom = isManualPreset ? custom : nil

        // Merge include flags (force to true since UI elements were removed)
        let includeFiles = (effectiveCustom?.includeFiles ?? preset.includeFiles) ?? true
        let includeUserPrompt = (effectiveCustom?.includeUserPrompt ?? preset.includeUserPrompt) ?? true
        let includeMetaPrompts = (effectiveCustom?.includeMetaPrompts ?? preset.includeMetaPrompts) ?? true
        let includeFileTree = (effectiveCustom?.includeFileTree ?? preset.includeFileTree) ?? true

        // File-tree and code-map behaviour (fallback to current UI)
        let desiredFileTreeMode = effectiveCustom?.fileTreeMode ?? preset.fileTreeMode ?? fileTreeOption

        let desiredCodeMapUsage = Self.resolveCopyCodeMapUsage(
            isManualPreset: isManualPreset,
            customCodeMapUsage: effectiveCustom?.codeMapUsage,
            presetCodeMapUsage: preset.codeMapUsage,
            uiCodeMapUsage: codeMapUsage,
            globallyDisabled: codeMapsGloballyDisabled
        )

        let desiredGitInclusion = Self.mapGitInclusion(
            custom: effectiveCustom?.gitInclusion,
            preset: preset.gitInclusion,
            uiMode: gitViewModel.gitDiffInclusionMode,
            isManualPreset: isManualPreset
        )

        return PromptContextResolved(
            includeFiles: includeFiles,
            includeUserPrompt: includeUserPrompt,
            includeMetaPrompts: includeMetaPrompts,
            includeFileTree: includeFileTree,
            fileTreeMode: desiredFileTreeMode,
            codeMapUsage: desiredCodeMapUsage,
            gitInclusion: desiredGitInclusion,
            storedPromptIds: preset.storedPromptIds
        )
    }
    // swiftlint:disable identifier_name
    static func mapGitInclusion(
        custom: GitInclusion?,
        preset: GitInclusion?,
        uiMode: GitDiffInclusionMode,
        isManualPreset: Bool
    ) -> GitInclusion {
        if let c = custom {
            return c
        }
        if let p = preset {
            return p
        }
        if isManualPreset {
            switch uiMode {
            case .none:
                return .none
            case .selectedFiles:
                return .selected
            case .all:
                return .complete
            }
        }
        return .none
    }
    // swiftlint:enable identifier_name
}
enum CapturedCopyPreset: Decodable {
    case builtIn(ClipboardPresetKind)
    case manual(CapturedCopySettings)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let name = try? value.decode(String.self), let kind = ClipboardPresetKind(rawValue: name) {
            self = .builtIn(kind)
        } else { self = try .manual(value.decode(CapturedCopySettings.self)) }
    }

    var kind: String {
        switch self {
        case let .builtIn(value): value.rawValue
        case .manual: "manual"
        }
    }

    var selectedPromptIDs: [UUID]? {
        switch self {
        case .builtIn: nil
        case let .manual(value): value.selectedPromptIds
        }
    }

    func resolve() -> PromptContextResolved {
        switch self {
        case let .manual(settings):
            return ClipboardPresetResolver(fileTreeOption: settings.current.fileTreeMode,
                                           codeMapUsage: settings.current.codeMapUsage,
                                           codeMapsGloballyDisabled: settings.codeMapsGloballyDisabled,
                                           gitViewModel: CapturedGitSettings(gitDiffInclusionMode: settings.current
                                               .gitInclusion))
                .resolvePromptContext(BuiltInCopyPresets.manual, custom: settings.customizations)
        case let .builtIn(kind):
            let preset = switch kind {
            case .standard: BuiltInCopyPresets.standard
            case .plan: BuiltInCopyPresets.plan
            case .diffFollowUp: BuiltInCopyPresets.diffFollowUp
            case .codeReview: BuiltInCopyPresets.codeReview
            }
            return ClipboardPresetResolver(fileTreeOption: .auto, codeMapUsage: .auto, codeMapsGloballyDisabled: false,
                                           gitViewModel: CapturedGitSettings(gitDiffInclusionMode: .none))
                .resolvePromptContext(
                    preset,
                    custom: nil,
                )
        }
    }

    var wireResolved: [String: Any] {
        let cfg = resolve()
        var result: [String: Any] = ["kind": kind, "gitInclusion": cfg.gitInclusion.rawValue,
                                     "includeMetaPrompts": cfg.includeMetaPrompts,
                                     "storedPromptIds": cfg.storedPromptIds
                                         .map { $0.map { $0.uuidString.lowercased() } } as Any? ?? NSNull()]
        if case .manual = self {
            result.merge(["includeFiles": cfg.includeFiles, "includeUserPrompt": cfg.includeUserPrompt,
                          "includeFileTree": cfg.includeFileTree, "fileTreeMode": cfg.fileTreeMode.rawValue,
                          "codeMapUsage": cfg.codeMapUsage.rawValue]) { _, value in value }
        }
        return result
    }
}
