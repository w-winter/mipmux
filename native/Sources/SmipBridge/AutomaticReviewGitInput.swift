import Foundation

struct AutomaticReviewGitInput {
    private let value: Any
    private let kind: String

    init(_ value: Any) throws {
        guard let object = value as? [String: Any], let kind = object["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        self.value = value
        self.kind = kind
    }

    func render(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        if kind == "resolveAutomaticReviewGit" { return try await resolve(resolver: resolver) }
        let input = try WireObject(value, keys: ["kind", "outcomes", "pathIssues"])
        guard let rows = try input.value("outcomes") as? [[String: Any]],
              let issues = try input.value("pathIssues") as? [[String: Any]]
        else {
            throw BridgeFailure("nativeProtocolError")
        }
        let decoded = try rows.map(Self.decodeOutcome)
        let outcomes = decoded.map(\.source)
        let pathIssues = try issues.map(Self.pathIssue)
        let hasFailures = !pathIssues.isEmpty || outcomes.contains { !$0.isSuccessful }
        let hasSuccessfulCheckout = outcomes.contains { $0.isSuccessful }
        let completeness: RPCEAutomaticReviewGitRendering.Completeness = if !hasFailures {
            .complete
        } else if hasSuccessfulCheckout {
            .partial
        } else {
            .failed
        }
        var bodySpans: [[String: Int]] = []
        let text = RPCEAutomaticReviewGitRendering().renderText(
            outcomes: outcomes, pathIssues: pathIssues, completeness: completeness, bodySpans: &bodySpans
        )
        return ["kind": "automaticReviewGit", "completeness": completeness.rawValue,
                "outcomes": decoded.map(\.normalized),
                "text": text as Any? ?? NSNull(), "bodySpans": bodySpans]
    }

    private static func decodeOutcome(
        _ row: [String: Any]
    ) throws -> (source: ReviewGitCheckoutOutcome, normalized: [String: Any]) {
        guard let checkout = row["checkout"] as? [String: Any],
              let identity = checkout["identity"] as? [String: Any],
              let root = identity["checkoutRootPath"] as? String,
              let label = checkout["displayLabel"] as? String,
              let paths = checkout["selectedPaths"] as? [String], let kind = row["kind"] as? String
        else {
            throw BridgeFailure("nativeProtocolError")
        }
        let captured = ReviewGitCheckout(checkoutRootPath: root, displayLabel: label, selectedPaths: paths)
        if kind == "diff" {
            guard let text = row["text"] as? String else { throw BridgeFailure("nativeProtocolError") }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (.diff(checkout: captured, text: text), row)
            }
            return (.noChanges(checkout: captured), ["kind": "noChanges", "checkout": checkout])
        }
        switch kind {
        case "noChanges": return (.noChanges(checkout: captured), row)
        case "baseResolutionFailed": return (
                .baseResolutionFailed(checkout: captured, summary: "Comparison base resolution failed."), row
            )
        case "commandFailed": return (.commandFailed(checkout: captured, summary: "Git diff generation failed."), row)
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    private func resolve(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        let input = try WireObject(value, keys: ["kind", "roots", "paths", "unresolvedCandidates", "base"])
        let rawBase: String? = try input.value("base") is NSNull ? nil : input.string("base")
        guard let roots = try input.value("roots") as? [[String: String]],
              let paths = try input.value("paths") as? [String],
              let unresolved = try input.value("unresolvedCandidates") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        let display = try ReviewGitDisplayContext(roots: roots.map { root in
            guard let path = root["path"], let name = root["name"] else { throw BridgeFailure("nativeProtocolError") }
            return ReviewGitDisplayRoot(logicalRootPath: path, logicalRootName: name, physicalRootPath: path)
        })
        let ownershipResolver = ReviewGitSelectedPathOwnershipResolver(dependencies: .live(resolver: resolver))
        let ownership = try await ownershipResolver.resolve(
            WorkspaceSelectedGitPathResolution(paths: paths, unresolvedCandidates: unresolved), displayContext: display
        )
        let checkouts = try ownership.checkouts.map { group -> [String: Any] in
            guard let path = group.selectedPaths.first,
                  let root = roots.filter({ root in
                      guard let rootPath = root["path"] else { return false }
                      return StandardizedPath.isDescendant(path, of: StandardizedPath.absolute(rootPath))
                  }).max(by: { ($0["path"]?.count ?? 0) < ($1["path"]?.count ?? 0) }),
                  let name = root["name"] else { throw BridgeFailure("nativeProtocolError") }
            let identity = GitTargetInput.Checkout(root: name, checkoutRootPath: group.checkoutRootPath,
                                                   repoKey: group.repoKey, repositoryID: group.repositoryID,
                                                   worktreeID: group.worktreeID, kind: group.kind)
            return ["identity": identity.json, "displayLabel": group.displayLabel, "selectedPaths": group.selectedPaths]
        }
        let base: String? = switch ReviewGitCompareIntent(base: rawBase) {
        case .uncommittedHEAD: nil
        case let .uncommittedMergeBase(symbolicBase): symbolicBase
        }
        return ["kind": "automaticReviewGitPaths", "checkouts": checkouts,
                "pathIssues": ownership.pathIssues.map(Self.json), "base": base as Any? ?? NSNull()]
    }

    private static func pathIssue(_ row: [String: Any]) throws -> ReviewGitPathIssue {
        guard let kind = row["kind"] as? String, let path = row["displayPath"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        switch kind {
        case "unresolvedSelection": return .unresolvedSelection(displayPath: path)
        case "noRepository": return .noRepository(displayPath: path)
        case "invalidGitLayout": return .invalidGitLayout(displayPath: path)
        case "unsupportedBackend":
            guard let raw = row["backend"] as? String, let backend = VCSBackendKind(rawValue: raw) else {
                throw BridgeFailure("nativeProtocolError")
            }
            return .unsupportedBackend(displayPath: path, backendKind: backend)
        default: throw BridgeFailure("nativeProtocolError")
        }
    }

    private static func json(_ issue: ReviewGitPathIssue) -> [String: Any] {
        switch issue {
        case let .unresolvedSelection(path): ["kind": "unresolvedSelection", "displayPath": path]
        case let .noRepository(path): ["kind": "noRepository", "displayPath": path]
        case let .invalidGitLayout(path): ["kind": "invalidGitLayout", "displayPath": path]
        case let .unsupportedBackend(path, backend):
            ["kind": "unsupportedBackend", "displayPath": path, "backend": backend.rawValue]
        }
    }
}
