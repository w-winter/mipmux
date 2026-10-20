// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct GitPublicationPlanInput {
    private let repos: [GitRepoDescriptor]
    private let paths: [String]
    private let pathspecs: [String]
    private let selected: Bool
    private static let maxConcurrentRepositories = 3

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "repositories", "paths", "pathspecs", "scope"])
        guard let roots = try fields.value("repositories") as? [String],
              let paths = try fields.value("paths") as? [String],
              let pathspecs = try fields.value("pathspecs") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        let scope = try fields.string("scope")
        guard ["all", "selected"].contains(scope) else { throw BridgeFailure("nativeProtocolError") }
        repos = roots.map { GitRepoDescriptor(rootURL: URL(fileURLWithPath: $0)) }
        self.paths = paths
        self.pathspecs = pathspecs.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        selected = scope == "selected" && self.pathspecs.isEmpty
    }

    func render() -> [String: Any] {
        let grouped = selected ? groupAbsolutePathsByRepo(paths: paths, repos: repos) : [:]
        let rows = repos.map { repo -> [String: Any] in
            let selectedPaths = selected ? grouped[repo] ?? [] : []
            let emptyReason: String?
            if !pathspecs.isEmpty,
               GitDiffPathNormalization.gitPathspecs(from: pathspecs, repoRootPath: repo.rootPath).isEmpty {
                emptyReason = "No requested paths in this repo"
            } else if selected, selectedPaths.isEmpty {
                emptyReason = "No selected paths in this repo"
            } else {
                emptyReason = nil
            }
            return ["path": repo.rootPath, "name": repo.displayName, "selectedPaths": selectedPaths,
                    "usesSelectedScope": selected, "emptyReason": emptyReason as Any? ?? NSNull()]
        }
        return ["kind": "gitPublicationPlan", "repositories": rows,
                "maxConcurrentRepositories": Self.maxConcurrentRepositories]
    }

    private func groupAbsolutePathsByRepo(paths: [String],
                                          repos: [GitRepoDescriptor]) -> [GitRepoDescriptor: [String]] {
        var result: [GitRepoDescriptor: [String]] = [:]
        for repo in repos {
            result[repo] = []
        }
        for path in paths {
            let standardized = (path as NSString).standardizingPath
            var bestMatch: GitRepoDescriptor?
            var bestLength = 0
            // swiftlint:disable for_where
            for repo in repos {
                if repo.contains(absolutePath: standardized) {
                    if repo.rootPath.count > bestLength {
                        bestMatch = repo
                        bestLength = repo.rootPath.count
                    }
                }
            }
            // swiftlint:enable for_where
            if let match = bestMatch { result[match, default: []].append(standardized) }
        }
        return result
    }
}
