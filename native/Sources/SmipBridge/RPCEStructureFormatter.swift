// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable cyclomatic_complexity function_body_length line_length type_body_length
import Foundation

enum RPCEStructureFormatter {
    static func formatCodeStructure(dto: ToolResultDTOs.CodeStructureReplyDTO) -> String {
        let allIssues = dto.issues + dto.roots.flatMap(\.issues)
        let externalEdgeCount = dto.roots.reduce(0) { count, root in
            count + root.edges.count(where: { $0.from != $0.to })
        }
        let relatedCount = dto.roots.reduce(0) { count, root in
            count + root.nodes.count(where: { $0.seed != true })
        }
        let hasUsefulResult = dto.summary.nodes > 0 || dto.summary.files > 0
        let resultSummary = codeStructureResultSummary(
            dto: dto,
            relatedCount: relatedCount,
            externalEdgeCount: externalEdgeCount
        )

        func earlyResultText() -> String? {
            if dto.status == .unavailable {
                var out = ["## Code Structure ❌ unavailable — \(codeStructureUnavailableCause(issues: allIssues))"]
                if let requested = allIssues.first(where: { $0.code == "path_not_found" })?.path {
                    out.append("- Requested: `\(requested)`")
                }
                out.append("- \(codeStructureUnavailableAction(issues: allIssues))")
                if dto.worktreeScope != nil {
                    out.append("- Scope: session-bound worktree. Displayed paths use logical/canonical roots; codemap scans use the bound checkout.")
                }
                return out.joined(separator: "\n")
            }

            if dto.status == .pending, !hasUsefulResult {
                let path = codeStructurePendingSeedPath(dto: dto, issues: allIssues)
                var out = [
                    "## Code Structure ⏳ pending — `\(path)` is not in the code graph yet",
                    "- Retry shortly. If this persists, the file may be excluded or of an unsupported type."
                ]
                if dto.worktreeScope != nil {
                    if dto.roots.count == 1, let root = dto.roots.first {
                        out.append(codeStructureRootDeclaration(root.root, scope: dto.worktreeScope))
                    } else {
                        out.append("- Scope: session-bound worktree. Displayed paths use logical/canonical roots; codemap scans use the bound checkout.")
                    }
                }
                return out.joined(separator: "\n")
            }
            return nil
        }
        if let text = earlyResultText() { return text }

        let graphTruncated = dto.roots.contains { $0.truncated != nil }
        var out: [String]
        switch dto.status {
        case .ok:
            let suffix = hasUsefulResult ? " — \(resultSummary)" : ""
            out = ["## Code Structure ✅\(suffix)"]
        case .partial, .pending:
            var title = "## Code Structure ⚠️ partial — a retry may return more relationships"
            if graphTruncated {
                title += "; \(codeStructureSizeAction(size: dto.size))"
            }
            out = [title]
            if hasUsefulResult { out.append("- Result: \(resultSummary)") }
        case .unavailable:
            preconditionFailure("Unavailable replies return above")
        }

        if dto.roots.count == 1, let root = dto.roots.first {
            out.append(codeStructureRootDeclaration(root.root, scope: dto.worktreeScope))
        } else if !dto.roots.isEmpty {
            let counts = Dictionary(grouping: dto.roots, by: \.status)
                .map { "\($0.value.count) \($0.key.rawValue)" }
                .sorted()
                .joined(separator: ", ")
            out.append("- Roots: \(dto.roots.count) (\(counts))")
        }
        if dto.worktreeScope != nil {
            out.append("- Scope: session-bound worktree. Displayed paths use logical/canonical roots; codemap scans use the bound checkout.")
        }

        func appendRoot(_ root: ToolResultDTOs.CodeStructureReplyDTO.RootDTO) {
            let rootFiles = dto.files.filter { codeStructurePath($0.path, belongsTo: root.root) }
            let externalEdges = root.edges.filter { $0.from != $0.to }
            let singleEdgeNeedsAttribution = externalEdges.count == 1
                && (root.seeds.count > 1 || root.nodes.count > 2)
            let shouldRenderGraph = rootFiles.isEmpty || externalEdges.count > 1
                || externalEdges.contains(where: { $0.ambiguous == true })
                || singleEdgeNeedsAttribution
            if dto.roots.count > 1 {
                out.append("")
                out.append("### \(codeStructureRootDeclaration(root.root, scope: dto.worktreeScope, bullet: false))")
            }
            if shouldRenderGraph, !root.nodes.isEmpty || !externalEdges.isEmpty {
                out.append("")
                out.append(dto.roots.count == 1 ? "### Graph" : "#### Graph")
                appendCodeStructureGraph(root: root, edges: externalEdges, to: &out)
            }
            let renderedPaths = Set(rootFiles.map(\.path))
            let omittedSignatureNodes = root.nodes.filter { !renderedPaths.contains($0.path) }
            let rootIssues = dto.issues + root.issues
            let signatureOmissionReported = rootIssues.contains { $0.code.hasPrefix("signature_") }
            if !rootFiles.isEmpty || signatureOmissionReported && !omittedSignatureNodes.isEmpty {
                out.append("")
                out.append(dto.roots.count == 1 ? "### Signatures" : "#### Signatures")
                appendCodeStructureSignatures(root: root.root, files: rootFiles, to: &out)
                if signatureOmissionReported, !omittedSignatureNodes.isEmpty {
                    let shown = omittedSignatureNodes.prefix(3).map {
                        "`\(codeStructureRelativePath($0.path, root: root.root))`"
                    }.joined(separator: ", ")
                    let remainder = omittedSignatureNodes.count > 3 ? " … +\(omittedSignatureNodes.count - 3) more" : ""
                    var omission = "- Omitted (\(omittedSignatureNodes.count)): \(shown)\(remainder)"
                    if rootIssues.contains(where: { $0.code == "signature_size_limit" }) {
                        omission += " — \(codeStructureSizeAction(size: dto.size))"
                    }
                    out.append(omission)
                }
            }
        }
        for root in dto.roots {
            appendRoot(root)
        }

        let unmatchedFiles = dto.files.filter { file in
            !dto.roots.contains(where: { codeStructurePath(file.path, belongsTo: $0.root) })
        }
        if !unmatchedFiles.isEmpty {
            out.append("")
            out.append("### Signatures")
            appendCodeStructureSignatures(root: nil, files: unmatchedFiles, to: &out)
        }

        let visibleIssues = allIssues.filter {
            !codeStructureIssueIsPresentedElsewhere($0)
        }
        let hasDiagnostics = !visibleIssues.isEmpty || dto.roots.contains { root in
            root.truncated != nil || hasUsefulResult && root.seeds.contains(where: { $0.state != .covered })
        }
        if hasDiagnostics {
            out.append("")
            out.append("### Diagnostics")
            appendCodeStructureDiagnostics(dto: dto, visibleIssues: visibleIssues, to: &out)
        }
        return out.joined(separator: "\n")
    }

    private static func codeStructureResultSummary(
        dto: ToolResultDTOs.CodeStructureReplyDTO,
        relatedCount: Int,
        externalEdgeCount: Int
    ) -> String {
        var summary = "\(dto.summary.seeds) seed\(dto.summary.seeds == 1 ? "" : "s")"
        if relatedCount > 0 { summary += " + \(relatedCount) related" }
        summary += " • \(externalEdgeCount) edge\(externalEdgeCount == 1 ? "" : "s")"
        if dto.summary.files > 0 {
            summary += " • signatures \(dto.summary.files) file\(dto.summary.files == 1 ? "" : "s"), \(dto.summary.tokens) tokens"
        }
        return summary
    }

    private static func codeStructurePendingSeedPath(
        dto: ToolResultDTOs.CodeStructureReplyDTO,
        issues: [ToolResultDTOs.CodeStructureReplyDTO.IssueDTO]
    ) -> String {
        for root in dto.roots {
            if let seed = root.seeds.first(where: { $0.state != .covered }) {
                return codeStructureRelativePath(seed.path, root: root.root)
            }
        }
        if let issuePath = issues.compactMap(\.path).first {
            if let root = dto.roots.first(where: { codeStructurePath(issuePath, belongsTo: $0.root) }) {
                return codeStructureRelativePath(issuePath, root: root.root)
            }
            return issuePath
        }
        return "requested seed"
    }

    private static func codeStructureUnavailableCause(
        issues: [ToolResultDTOs.CodeStructureReplyDTO.IssueDTO]
    ) -> String {
        if issues.contains(where: { $0.code == "path_not_found" }) {
            return "no requested path resolved"
        }
        if issues.contains(where: { $0.code == "codemaps_disabled" }) {
            return "codemap generation is disabled"
        }
        if issues.contains(where: { $0.code == "git_root_unavailable" }) {
            return "requested root is unavailable"
        }
        return issues.first.map { codeStructureSentenceFragment($0.message) } ?? "code structure is unavailable"
    }

    private static func codeStructureUnavailableAction(
        issues: [ToolResultDTOs.CodeStructureReplyDTO.IssueDTO]
    ) -> String {
        if issues.contains(where: { $0.code == "path_not_found" }) {
            return "Check spelling with get_file_tree, then retry root-relative or root-prefixed."
        }
        if issues.contains(where: { $0.code == "codemaps_disabled" }) {
            return "Enable codemaps, then retry."
        }
        if issues.contains(where: { $0.code == "git_root_unavailable" }) {
            return "Resolve the reported root issue, then retry."
        }
        return "Resolve the reported issue, then retry."
    }

    private static func codeStructureSizeAction(size: WorkspaceCodemapGraphOutputSize) -> String {
        switch size {
        case .small: "rerun with size: medium"
        case .medium: "rerun with size: large"
        case .large: "narrow paths or reduce depth; size is already large"
        }
    }

    private static func appendCodeStructureGraph(
        root: ToolResultDTOs.CodeStructureReplyDTO.RootDTO,
        edges: [ToolResultDTOs.CodeStructureReplyDTO.EdgeDTO],
        to output: inout [String]
    ) {
        let relativeNodes = root.nodes.map { codeStructureRelativePath($0.path, root: root.root) }
        let relativeEdges = edges.flatMap {
            [codeStructureRelativePath($0.from, root: root.root), codeStructureRelativePath($0.to, root: root.root)]
        }
        let base = codeStructureSharedBase(paths: relativeNodes + relativeEdges)
        if let base { output.append("Base: `\(base)`") }

        let outgoing = Dictionary(grouping: edges, by: \.from)
        let connectedPaths = Set(edges.flatMap { [$0.from, $0.to] })
        for node in root.nodes {
            let source = codeStructureCompactPath(node.path, root: root.root, base: base)
            if let nodeEdges = outgoing[node.path], !nodeEdges.isEmpty {
                let role = node.seed == true ? " (seed)" : ""
                output.append("- `\(source)`\(role) → uses:")
                for edge in nodeEdges {
                    let target = codeStructureCompactPath(edge.to, root: root.root, base: base)
                    let symbols = edge.symbols.isEmpty ? "" : " — \(edge.symbols.joined(separator: ", "))"
                    let ambiguous = edge.ambiguous == true ? " (ambiguous)" : ""
                    output.append("  - `\(target)`\(symbols)\(ambiguous)")
                }
            } else if !connectedPaths.contains(node.path) {
                let role = node.seed == true ? " (seed)" : ""
                output.append("- `\(source)`\(role) — no relationships returned")
            }
        }
    }

    private static func appendCodeStructureSignatures(
        root: String?,
        files: [ToolResultDTOs.CodeStructureReplyDTO.FileDTO],
        to output: inout [String]
    ) {
        let relativePaths = files.map { file in
            root.map { codeStructureRelativePath(file.path, root: $0) } ?? file.path
        }
        let base = codeStructureSharedBase(paths: relativePaths)
        if let base { output.append("Base: `\(base)`") }
        for file in files {
            let relativePath = root.map { codeStructureRelativePath(file.path, root: $0) } ?? file.path
            let path = codeStructureStripBase(relativePath, base: base)
            let role: String = if file.role == "seed" {
                "seed"
            } else if !file.reachedBy.isEmpty {
                file.reachedBy.joined(separator: "/") + ", depth \(file.depth)"
            } else {
                "related, depth \(file.depth)"
            }
            output.append("#### `\(path)` — \(role) • \(file.tokens) tokens")
            output.append("```text\n\(codeStructureSignatureContent(file.content, path: file.path))\n```")
        }
    }

    private static func appendCodeStructureDiagnostics(
        dto: ToolResultDTOs.CodeStructureReplyDTO,
        visibleIssues: [ToolResultDTOs.CodeStructureReplyDTO.IssueDTO],
        to output: inout [String]
    ) {
        let multipleRoots = dto.roots.count > 1
        let hasUsefulResult = dto.summary.nodes > 0 || dto.summary.files > 0
        for root in dto.roots {
            let label = multipleRoots ? "`\(root.root)` " : ""
            if hasUsefulResult {
                for seed in root.seeds where seed.state != .covered {
                    let path = codeStructureRelativePath(seed.path, root: root.root)
                    output.append("- \(label)Seed `\(path)` returned nothing — excluded or unsupported type")
                }
            }
            if let truncated = root.truncated {
                output.append("- \(label)Truncated: \(truncated.droppedNodes) files dropped")
            }
        }

        for issue in visibleIssues {
            var detail = "- \(codeStructureSentenceFragment(issue.message))"
            if let issuePath = issue.path {
                let root = dto.roots.first(where: { codeStructurePath(issuePath, belongsTo: $0.root) })?.root
                let path = root.map { codeStructureRelativePath(issuePath, root: $0) } ?? issuePath
                detail += " [`\(path)`]"
            }
            output.append(detail)
        }
    }

    private static func codeStructureIssueIsPresentedElsewhere(
        _ issue: ToolResultDTOs.CodeStructureReplyDTO.IssueDTO
    ) -> Bool {
        switch issue.code {
        case "codemaps_disabled", "empty_seeds", "git_root_unavailable", "graph_deadline",
             "graph_indexing", "graph_revalidation_failed", "graph_revoked", "graph_size_limit",
             "graph_unavailable", "path_not_found", "seed_excluded", "seed_fenced", "seed_not_indexed",
             "seed_pending", "signature_pending", "signature_publication_stale", "signature_size_limit",
             "signature_unavailable", "updates_pending", "watcher_gap_reconciling":
            true
        default:
            false
        }
    }

    private static func codeStructureSentenceFragment(_ message: String) -> String {
        message.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".;")))
    }

    private static func codeStructureRootDeclaration(
        _ root: String,
        scope: ToolResultDTOs.WorktreeScopeDTO?,
        bullet: Bool = true
    ) -> String {
        var declaration = "\(bullet ? "- Root " : "Root ")`\(root)` — paths below are root-relative"
        if let mapping = scope?.rootMappings.first(where: { $0.logicalRootName == root }) {
            var details = ["worktree `\(mapping.worktreeID)`"]
            if let branch = nonEmpty(mapping.branch) { details.append("branch `\(branch)`") }
            if let label = nonEmpty(mapping.label) { details.append("label `\(label)`") }
            declaration += "; session-bound \(details.joined(separator: ", "))"
        }
        return declaration
    }

    private static func codeStructurePath(_ path: String, belongsTo root: String) -> Bool {
        path == root || path.hasPrefix(root + "/")
    }

    private static func codeStructureRelativePath(_ path: String, root: String) -> String {
        guard codeStructurePath(path, belongsTo: root) else { return path }
        if path == root { return "." }
        return String(path.dropFirst(root.count + 1))
    }

    private static func codeStructureCompactPath(_ path: String, root: String, base: String?) -> String {
        codeStructureStripBase(codeStructureRelativePath(path, root: root), base: base)
    }

    private static func codeStructureStripBase(_ path: String, base: String?) -> String {
        guard let base, path.hasPrefix(base) else { return path }
        return String(path.dropFirst(base.count))
    }

    private static func codeStructureSharedBase(paths: [String]) -> String? {
        let unique = Array(Set(paths)).sorted()
        guard unique.count >= 2 else { return nil }
        let components = unique.map { $0.split(separator: "/").map(String.init) }
        guard let first = components.first else { return nil }
        var prefix = Array(first.dropLast())
        guard !prefix.isEmpty else { return nil }
        for pathComponents in components.dropFirst() {
            let directory = pathComponents.dropLast()
            prefix = Array(zip(prefix, directory).prefix(while: { $0.0 == $0.1 }).map(\.0))
            if prefix.isEmpty { return nil }
        }
        let base = prefix.joined(separator: "/") + "/"
        let compacted = unique.map { codeStructureStripBase($0, base: base) }
        guard Set(compacted).count == unique.count else { return nil }
        let savedCharacters = base.count * unique.count - base.count - 9
        return savedCharacters >= 40 ? base : nil
    }

    private static func codeStructureSignatureContent(_ content: String, path: String) -> String {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.first.map(String.init) == "File: \(path)" else { return content }
        return lines.dropFirst().joined(separator: "\n")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

// swiftlint:enable cyclomatic_complexity function_body_length line_length type_body_length
