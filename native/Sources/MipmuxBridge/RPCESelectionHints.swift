// RPCE selection hint policy with captured roots in place of app lookups.
import Foundation

enum RPCESelectionHints {
    static func makeSelectionHintError(
        paths: [String],
        operation: String,
        roots: [WorkspaceRootRef]
    ) -> String {
        let trimmed = paths.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if roots.isEmpty {
            return "No workspace is currently loaded in this window. "
                + "Use the 'manage_workspaces' tool with action: 'list' to see available workspaces, "
                + "then action: 'switch' to load one."
        }

        let displayRoots = roots
        let rootSummaries = displayRoots.map { "\($0.name) → \($0.fullPath)" }.joined(separator: "; ")

        var outside: [String] = []
        for path in trimmed where path.hasPrefix("/") {
            let standardized = StandardizedPath.absolute(path)
            let under = roots.contains {
                standardized == $0.standardizedFullPath
                    || StandardizedPath.isDescendant(standardized, of: $0.standardizedFullPath)
            }
            if !under { outside.append(path) }
        }

        var lines: [String] = []
        lines.append("No provided paths matched any files or folders for '\(operation)'.")
        lines.append("Loaded roots: \(rootSummaries)")
        lines.append(
            "Provide either: (a) Root-name + relative path (e.g., 'Root/Sub/Path.swift'), "
                + "or (b) a full absolute path under a loaded root."
        )
        if !outside.isEmpty {
            let sample = outside.prefix(2).joined(separator: ", ")
            lines.append("Not under any loaded root: \(sample)")
        }
        return lines.joined(separator: " ")
    }
}
