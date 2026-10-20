// Derived from RPCE IgnoreSettingsDefaults.swift:7-47; no desktop preference storage.
import Foundation

enum RPCEIgnoreSettingsDefaults {
    static let currentGlobalIgnoreDefaultsVersion = 2

    /// Canonical default patterns (do NOT include `.git`; that is always ignored separately).
    /// These mirror our "big dirs" heuristic plus a few common temp files.
    static let canonicalGlobalIgnoreDefaults: String = """
    # RepoPrompt global ignore defaults (v\(currentGlobalIgnoreDefaultsVersion))
    **/node_modules/
    **/.npm/
    **/.pnpm-store/
    **/.yarn/
    **/.cache/
    **/bower_components/

    **/__pycache__/
    **/.pytest_cache/
    **/.mypy_cache/

    **/.gradle/
    **/.m2/
    **/.nuget/
    **/.cargo/
    **/.stack-work/
    **/.ccache/

    **/.idea/
    **/.vscode/
    **/.bundle/
    **/.gem/

    # Virtual environments
    **/.venv/
    **/venv/

    # Common temp/junk files
    **/*.swp
    **/*~
    **/*.tmp
    **/*.temp
    **/*.bak
    """
}

struct IgnoreSettings {
    let global: String
    let respectRepoIgnore: Bool
    let respectCursorignore: Bool
    let enableHierarchicalIgnores: Bool

    init(_ value: Any) throws {
        if value is NSNull {
            global = RPCEIgnoreSettingsDefaults.canonicalGlobalIgnoreDefaults
            respectRepoIgnore = true
            respectCursorignore = true
            enableHierarchicalIgnores = true
        } else {
            let fields = try WireObject(value, keys: [
                "global", "respectRepoIgnore", "respectCursorignore", "enableHierarchicalIgnores"
            ])
            guard let globalText = try fields.value("global") as? String else {
                throw BridgeFailure("nativeProtocolError")
            }
            global = globalText
            respectRepoIgnore = try fields.boolean("respectRepoIgnore")
            respectCursorignore = try fields.boolean("respectCursorignore")
            enableHierarchicalIgnores = try fields.boolean("enableHierarchicalIgnores")
        }
    }

    var json: [String: Any] {
        ["global": global, "respectRepoIgnore": respectRepoIgnore,
         "respectCursorignore": respectCursorignore, "enableHierarchicalIgnores": enableHierarchicalIgnores]
    }
}
