// Derived from RPCE HierarchicalIgnoreEvaluator.swift:1-96; DEBUG metrics omitted.
import Foundation

/// Evaluates paths against a hierarchy of ignore rules, checking each prefix
/// to ensure parent directories that are ignored also ignore their children.
final class RPCEHierarchicalIgnoreEvaluator {
    /// A provider of ignore rules for a given directory path
    protocol RulesProvider {
        /// Get the effective ignore rules for a directory
        /// - Parameters:
        ///   - directoryPath: The relative path to the directory (empty string for root)
        /// - Returns: The ignore rules that apply at this directory level
        func rulesForDirectory(_ directoryPath: String) async throws -> IgnoreRules
    }

    private let rulesProvider: RulesProvider

    init(rulesProvider: RulesProvider) {
        self.rulesProvider = rulesProvider
    }

    /// Check if a path is ignored, considering all parent directories
    /// - Parameters:
    ///   - relativePath: The relative path to check
    ///   - isDirectory: Whether the final component is a directory
    /// - Returns: true if the path or any parent directory is ignored
    func isIgnored(relativePath: String, isDirectory: Bool) async throws -> Bool {
        let components = relativePath.split(separator: "/").map(String.init)
        return try await isIgnored(components: components, isDirectory: isDirectory)
    }

    /// Check if a path is ignored, considering all parent directories
    /// - Parameters:
    ///   - components: Pre-split path components
    ///   - isDirectory: Whether the final component is a directory
    /// - Returns: true if the path or any parent directory is ignored
    func isIgnored(components: [String], isDirectory finalIsDirectory: Bool) async throws -> Bool {
        guard !components.isEmpty else {
            return false
        }

        var pathSoFar = ""
        var lastOutcome: CompiledIgnoreRules.MatchOutcome?
        var lockedRules: IgnoreRules?

        for (index, component) in components.enumerated() {
            let isLastComponent = (index == components.count - 1)
            let isDirectory = isLastComponent ? finalIsDirectory : true
            pathSoFar = index == 0 ? component : "\(pathSoFar)/\(component)"
            let parentPath = index == 0 ? "" : components[0 ..< index].joined(separator: "/")

            let rules: IgnoreRules
            if let locked = lockedRules {
                rules = locked
            } else {
                rules = try await rulesProvider.rulesForDirectory(parentPath)
            }

            let pathComps = pathSoFar.split(separator: "/")
            if let outcome = rules.matchOutcome(relativePathComponents: pathComps, isDirectory: isDirectory) {
                lastOutcome = outcome
                switch outcome {
                case .ignore:
                    if lockedRules == nil {
                        lockedRules = rules
                    }
                case .allow:
                    lockedRules = nil
                case .noMatch:
                    break
                }
            }
        }

        return lastOutcome == .ignore
    }
}
