// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: explicit captured settings and catalog replace application storage.
import Foundation

struct CapturedCopyPreset: Decodable {
    let raw: CopyPreset
    let includeFiles: Bool
    let includeUserPrompt: Bool
    let includeFileTree: Bool
    let fileTreeMode: FileTreeOption
    let codeMapUsage: CodeMapUsage
    let gitInclusion: GitInclusion

    init(raw: CopyPreset, settings: CapturedCopySettings) {
        self.raw = raw
        let cfg = ClipboardPresetResolver(fileTreeOption: settings.current.fileTreeMode,
                                          codeMapUsage: settings.current.codeMapUsage,
                                          codeMapsGloballyDisabled: settings.codeMapsGloballyDisabled,
                                          gitViewModel: CapturedGitSettings(gitDiffInclusionMode: settings.current
                                              .gitInclusion))
            .resolvePromptContext(raw, custom: settings.customizations)
        includeFiles = cfg.includeFiles
        includeUserPrompt = cfg.includeUserPrompt
        includeFileTree = cfg.includeFileTree
        fileTreeMode = cfg.fileTreeMode
        codeMapUsage = cfg.codeMapUsage
        gitInclusion = cfg.gitInclusion
    }

    func resolve() -> PromptContextResolved {
        PromptContextResolved(includeFiles: includeFiles, includeUserPrompt: includeUserPrompt,
                              includeFileTree: includeFileTree,
                              fileTreeMode: fileTreeMode, codeMapUsage: codeMapUsage,
                              gitInclusion: gitInclusion)
    }

    var wireResolved: [String: Any] {
        ["raw": raw.wire, "includeFiles": includeFiles, "includeUserPrompt": includeUserPrompt,
         "includeFileTree": includeFileTree,
         "fileTreeMode": fileTreeMode.rawValue, "codeMapUsage": codeMapUsage.rawValue,
         "gitInclusion": gitInclusion.rawValue]
    }
}

extension CopyPreset {
    var wire: [String: Any] {
        ["id": id.uuidString.lowercased(), "name": name, "builtInKind": builtInKind?.rawValue as Any? ?? NSNull(),
         "description": description as Any? ?? NSNull(), "icon": icon as Any? ?? NSNull(), "isBuiltIn": isBuiltIn,
         "includeFiles": includeFiles as Any? ?? NSNull(), "includeUserPrompt": includeUserPrompt as Any? ?? NSNull(),
         "includeFileTree": includeFileTree as Any? ?? NSNull(),
         "fileTreeMode": fileTreeMode?.rawValue as Any? ?? NSNull(),
         "codeMapUsage": codeMapUsage?.rawValue as Any? ?? NSNull(),
         "gitInclusion": gitInclusion?.rawValue as Any? ?? NSNull(),
         "notes": notes as Any? ?? NSNull()]
    }
}

struct CopyPresetCatalogOperation {
    let settings: CapturedCopySettings
    let selector: CopyPresetSelector?
    let listing: Bool

    init(_ value: Any, listing: Bool) throws {
        let object = try WireObject(value, keys: listing ? ["kind", "context"] : ["kind", "context", "selector"])
        settings = try JSONDecoder().decode(CapturedCopySettings.self,
                                            from: JSONSerialization.data(withJSONObject: object.value("context")))
        self.listing = listing
        selector = try listing ? nil : Self.parseCopyPresetSelector(from: object.value("selector"))
    }

    static var builtIns: [CopyPreset] {
        [BuiltInCopyPresets.standard, BuiltInCopyPresets.diffFollowUp,
         BuiltInCopyPresets.codeReview, BuiltInCopyPresets.manual]
    }

    var allPresets: [CopyPreset] {
        Self.builtIns.map { base in
            guard let override = settings.presets.last(where: { $0.isBuiltIn && $0.id == base.id }) else { return base }
            return CopyPreset(id: base.id, name: base.name, builtInKind: base.builtInKind,
                              description: base.description, icon: base.icon, isBuiltIn: true,
                              includeFiles: override.includeFiles ?? base.includeFiles,
                              includeUserPrompt: override.includeUserPrompt ?? base.includeUserPrompt,
                              includeFileTree: override.includeFileTree ?? base.includeFileTree,
                              fileTreeMode: override.fileTreeMode ?? base.fileTreeMode,
                              codeMapUsage: override.codeMapUsage ?? base.codeMapUsage,
                              gitInclusion: override.gitInclusion ?? base.gitInclusion,
                              notes: base.notes)
        } + settings.presets.filter { !$0.isBuiltIn }
    }

    struct CopyPresetSelector {
        var id: UUID?
        var kind: CopyPresetKind?
        var name: String?
    }

    // MCPServerViewModel+CopyPresets: the wire adapter supplies string/object values instead of MCP.Value.
    static func parseCopyPresetSelector(from value: Any) -> CopyPresetSelector? {
        if let str = value as? String { return parseStringSelector(str) }
        if let obj = value as? [String: Any] {
            var selector = CopyPresetSelector()
            if let idStr = obj["id"] as? String, let uuid = UUID(uuidString: idStr) { selector.id = uuid }
            if let kindStr = obj["kind"] as? String {
                let lowercased = kindStr.lowercased()
                selector.kind = CopyPresetKind.allCases.first { $0.rawValue.lowercased() == lowercased }
            }
            if let nameStr = obj["name"] as? String {
                selector.name = nameStr.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            }
            if selector.id == nil, selector.kind == nil, selector.name?.isEmpty ?? true { return nil }
            return selector
        }
        return nil
    }

    private static func parseStringSelector(_ str: String) -> CopyPresetSelector? {
        let trimmed = str.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let uuid = UUID(uuidString: trimmed) { return CopyPresetSelector(id: uuid, kind: nil, name: nil) }
        let lowercased = trimmed.lowercased()
        for kind in CopyPresetKind.allCases where kind.rawValue.lowercased() == lowercased {
            return CopyPresetSelector(id: nil, kind: kind, name: nil)
        }
        return CopyPresetSelector(id: nil, kind: nil, name: trimmed)
    }

    func resolveCopyPreset(from selector: CopyPresetSelector) -> CopyPreset? {
        if let id = selector.id { return allPresets.first { $0.id == id } }
        if let kind = selector.kind { return Self.builtIns.first { $0.builtInKind == kind } }
        if let name = selector.name, !name.isEmpty {
            let lowercased = name.lowercased()
            return allPresets.first { $0.name.lowercased() == lowercased }
        }
        return nil
    }

    func render() -> [String: Any] {
        if listing { return ["kind": "copyPresets", "presets": allPresets.map(\.wire)] }
        let preset = selector.flatMap(resolveCopyPreset)
        return ["kind": "copyPreset", "hasSelector": selector != nil,
                "preset": preset
                    .map { CapturedCopyPreset(raw: $0, settings: settings).wireResolved } as Any? ?? NSNull()]
    }
}
