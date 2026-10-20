// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable function_body_length function_parameter_count line_length type_body_length
import Foundation

enum RPCEStructureReply {
    static func codeStructureReplyDTO(
        aggregate: WorkspaceCodemapStructureAggregateResult,
        presentation: StructureSignaturePresentation?,
        revalidation: [WorkspaceCodemapRootEpoch: WorkspaceCodemapStructureGraphRevalidationResult],
        includesSignatures: Bool,
        budget: WorkspaceCodemapGraphQueryBudget,
        size: WorkspaceCodemapGraphOutputSize,
        worktreeScope: ToolResultDTOs.WorktreeScopeDTO?
    ) -> ToolResultDTOs.CodeStructureReplyDTO {
        typealias DTO = ToolResultDTOs.CodeStructureReplyDTO
        let orderedRoots = aggregate.roots.sorted(by: {
            if $0.rootDisplayName != $1.rootDisplayName {
                return $0.rootDisplayName.utf8.lexicographicallyPrecedes($1.rootDisplayName.utf8)
            }
            return $0.rootEpoch.rootID.uuidString < $1.rootEpoch.rootID.uuidString
        })
        var globalIssues = aggregate.issues.map(codeStructureIssueDTO)
        let signatureIssueCoverage = presentation?.coverage ?? CodeStructureSignatureIssueCoverage()
        if let presentation { globalIssues.append(contentsOf: presentation.issues) }

        var renderedFiles: [DTO.FileDTO] = []
        var renderedFileIDs = Set<UUID>()
        var sizeOmittedFileIDs = Set<UUID>()
        var renderedTokenCount = 0
        let separatorTokens = TokenCalculationService.estimateTokens(for: "\n\n")
        var signatureBudgetReached = false
        func admitSignatures() {
            if includesSignatures, let presentation {
                let orderedSignatureNodes: [WorkspaceCodemapStructureNodeResult] = orderedRoots.flatMap { root -> [WorkspaceCodemapStructureNodeResult] in
                    if case .invalid? = revalidation[root.rootEpoch] { return [] }
                    return root.nodes
                }.sorted { lhs, rhs in
                    if lhs.isSeed != rhs.isSeed { return lhs.isSeed }
                    if lhs.depth != rhs.depth { return lhs.depth < rhs.depth }
                    if lhs.path != rhs.path { return lhs.path.utf8.lexicographicallyPrecedes(rhs.path.utf8) }
                    return lhs.fileID.uuidString < rhs.fileID.uuidString
                }
                for node in orderedSignatureNodes {
                    guard let rendered = presentation.renderedEntriesByFileID[node.fileID] else { continue }
                    let separator = renderedFiles.isEmpty ? 0 : separatorTokens
                    let attempted = renderedTokenCount + separator + rendered.tokenCount
                    guard attempted <= budget.renderTokenCount else {
                        signatureBudgetReached = true
                        sizeOmittedFileIDs.insert(node.fileID)
                        continue
                    }
                    renderedTokenCount = attempted
                    renderedFileIDs.insert(node.fileID)
                    renderedFiles.append(DTO.FileDTO(
                        path: node.path,
                        role: node.isSeed ? "seed" : "related",
                        depth: node.depth,
                        reachedBy: node.reachedBy.map(codeStructureDirectionName).sorted(),
                        content: rendered.text,
                        tokens: rendered.tokenCount
                    ))
                }
            }
            if signatureBudgetReached {
                globalIssues.append(DTO.IssueDTO(
                    code: "signature_size_limit",
                    phase: "render",
                    path: nil,
                    retryable: false,
                    retryAfterMilliseconds: nil,
                    attempted: nil,
                    limit: nil,
                    message: "Some signatures were omitted to fit the requested output size."
                ))
            }
        }
        admitSignatures()

        func rootDTO(_ root: WorkspaceCodemapStructureRootResult) -> DTO.RootDTO {
            let graphRevalidation = revalidation[root.rootEpoch]
            let graphInvalid = if case .invalid? = graphRevalidation { true } else { false }
            let revalidationUpdatesPending: Bool = if case let .valid(updatesPending)? = graphRevalidation {
                updatesPending
            } else {
                false
            }
            let coverage = root.coverage
            func baseIssues() -> [DTO.IssueDTO] {
                var rootIssues = root.issues.map { issue in
                    let mapped = codeStructureIssueDTO(issue)
                    guard issue.code == "seed_not_indexed", coverage?.isComplete != true else { return mapped }
                    return DTO.IssueDTO(
                        code: mapped.code,
                        phase: mapped.phase,
                        path: mapped.path,
                        retryable: true,
                        retryAfterMilliseconds: 100,
                        attempted: mapped.attempted,
                        limit: mapped.limit,
                        message: mapped.message
                    )
                }
                if case let .invalid(code, message)? = graphRevalidation {
                    rootIssues.append(DTO.IssueDTO(
                        code: code,
                        phase: "graph_revalidation",
                        path: nil,
                        retryable: false,
                        retryAfterMilliseconds: nil,
                        attempted: nil,
                        limit: nil,
                        message: message
                    ))
                }
                return rootIssues
            }
            var rootIssues = baseIssues()
            let signatureIssueCoversRoot = signatureIssueCoverage.coversAll ||
                signatureIssueCoverage.rootEpochs.contains(root.rootEpoch)
            func signatureMissing() -> Bool {
                return includesSignatures && !graphInvalid && !signatureIssueCoversRoot && root.nodes.contains {
                    !renderedFileIDs.contains($0.fileID) &&
                        !sizeOmittedFileIDs.contains($0.fileID) &&
                        !signatureIssueCoverage.fileIDs.contains($0.fileID)
                }
            }
            let missingSignature = signatureMissing()
            if missingSignature {
                rootIssues.append(DTO.IssueDTO(
                    code: "signature_unavailable",
                    phase: "render",
                    path: nil,
                    retryable: false,
                    retryAfterMilliseconds: nil,
                    attempted: nil,
                    limit: nil,
                    message: "One or more signatures could not be rendered; graph data remains usable."
                ))
            }
            func rootStatus() -> DTO.Status {
                return if graphInvalid {
                    .unavailable
                } else if root.status != .ok || revalidationUpdatesPending || missingSignature {
                    root.hasUsefulData ? .partial : codeStructureStatusDTO(root.status)
                } else {
                    .ok
                }
                }
            let status = rootStatus()
            return DTO.RootDTO(
                root: root.rootDisplayName,
                status: status,
                index: DTO.IndexDTO(
                    state: coverage?.isComplete == true ? .complete : .indexing,
                    indexed: coverage?.classifiedCount ?? 0,
                    total: coverage?.supportedCount ?? 0
                ),
                updatesPending: (root.updatesPending || revalidationUpdatesPending) ? true : nil,
                seeds: root.seeds.map {
                    DTO.SeedDTO(path: $0.path, state: codeStructureSeedStateDTO($0.state))
                },
                nodes: graphInvalid ? [] : root.nodes.map {
                    DTO.NodeDTO(
                        path: $0.path,
                        depth: $0.depth,
                        seed: $0.isSeed ? true : nil,
                        reachedBy: $0.reachedBy.map(codeStructureDirectionName).sorted()
                    )
                },
                edges: graphInvalid ? [] : root.edges.map {
                    DTO.EdgeDTO(
                        from: $0.fromPath,
                        to: $0.toPath,
                        symbols: $0.symbols,
                        ambiguous: $0.ambiguous ? true : nil
                    )
                },
                unresolved: graphInvalid ? [] : root.unresolved.map {
                    DTO.UnresolvedDTO(
                        from: $0.fromPath,
                        name: $0.name,
                        reason: codeStructureUnresolvedReasonDTO($0.reason)
                    )
                },
                truncated: graphInvalid ? nil : root.truncation.map {
                    DTO.TruncatedDTO(reason: "size", droppedNodes: $0.droppedNodeCount)
                },
                issues: rootIssues
            )
        }
        let rootDTOs = orderedRoots.map(rootDTO)

        let usableNodeCount = rootDTOs.reduce(0) { $0 + $1.nodes.count }
        let usableEdgeCount = rootDTOs.reduce(0) { $0 + $1.edges.count }
        let allIssues = globalIssues + rootDTOs.flatMap(\.issues)
        let hasUsefulData = usableNodeCount > 0 || usableEdgeCount > 0
        let status: DTO.Status = if hasUsefulData {
            globalIssues.isEmpty && rootDTOs.allSatisfy { $0.status == .ok } ? .ok : .partial
        } else if rootDTOs.contains(where: { $0.status == .pending }) {
            .pending
        } else {
            .unavailable
        }
        let retryableIssues = allIssues.filter(\.retryable)
        return DTO(
            status: status,
            size: size,
            roots: rootDTOs,
            files: renderedFiles,
            summary: DTO.SummaryDTO(
                seeds: rootDTOs.reduce(0) { $0 + $1.seeds.count },
                nodes: usableNodeCount,
                edges: usableEdgeCount,
                files: renderedFiles.count,
                tokens: renderedTokenCount
            ),
            issues: globalIssues,
            retry: retryableIssues.isEmpty ? nil : DTO.RetryDTO(
                retryable: true,
                retryAfterMilliseconds: retryableIssues.compactMap(\.retryAfterMilliseconds).max() ?? 100
            ),
            worktreeScope: worktreeScope
        )
    }

    static func codeStructureUnavailableReply(
        issue: ToolResultDTOs.CodeStructureReplyDTO.IssueDTO,
        size: WorkspaceCodemapGraphOutputSize,
        worktreeScope: ToolResultDTOs.WorktreeScopeDTO?
    ) -> ToolResultDTOs.CodeStructureReplyDTO {
        ToolResultDTOs.CodeStructureReplyDTO(
            status: .unavailable,
            size: size,
            roots: [],
            files: [],
            summary: .init(seeds: 0, nodes: 0, edges: 0, files: 0, tokens: 0),
            issues: [issue],
            retry: issue.retryable
                ? .init(retryable: true, retryAfterMilliseconds: issue.retryAfterMilliseconds ?? 100)
                : nil,
            worktreeScope: worktreeScope
        )
    }

    private static func codeStructureIssueDTO(
        _ issue: WorkspaceCodemapStructureIssueRecord
    ) -> ToolResultDTOs.CodeStructureReplyDTO.IssueDTO {
        let isSizeIssue = ["graph_size_limit", "signature_size_limit"].contains(issue.code)
        return .init(
            code: issue.code,
            phase: issue.phase,
            path: issue.path,
            retryable: issue.retryable,
            retryAfterMilliseconds: issue.retryAfterMilliseconds,
            attempted: isSizeIssue ? nil : issue.attempted,
            limit: isSizeIssue ? nil : issue.limit,
            message: issue.message
        )
    }

    private static func codeStructureStatusDTO(
        _ status: WorkspaceCodemapStructureStatus
    ) -> ToolResultDTOs.CodeStructureReplyDTO.Status {
        switch status {
        case .ok: .ok
        case .partial: .partial
        case .pending: .pending
        case .unavailable: .unavailable
        }
    }

    private static func codeStructureSeedStateDTO(
        _ state: WorkspaceCodemapStructureSeedState
    ) -> ToolResultDTOs.CodeStructureReplyDTO.SeedState {
        switch state {
        case .covered: .covered
        case .pending: .pending
        case .notIndexed: .notIndexed
        case .excluded: .excluded
        }
    }

    private static func codeStructureUnresolvedReasonDTO(
        _ reason: WorkspaceCodemapGraphUnresolvedReason
    ) -> ToolResultDTOs.CodeStructureReplyDTO.UnresolvedReason {
        switch reason {
        case .notIndexedYet: .notIndexedYet
        case .missing: .missing
        case .tooCommon: .tooCommon
        }
    }

    private static func codeStructureDirectionName(
        _ direction: WorkspaceCodemapStructureTraversalReachDirection
    ) -> String {
        switch direction {
        case .referencedDefinitions: "uses"
        case .referrers: "used_by"
        }
    }
}

// swiftlint:enable function_body_length function_parameter_count line_length type_body_length
