import Foundation

private struct ScriptedPresentation {
    let entries: [WorkspaceCodemapOperationRenderedEntry]
    let issues: [WorkspaceCodemapOperationIssue]
    let receipt: WorkspaceCodemapOperationPresentationPublicationReceipt?
}

@MainActor private final class FixtureRuntime {
    let input: Input
    var trace: [String] = []
    var operations: [OperationValue] = []
    private var attemptCount = 0
    private var preparedCount = 0
    private var bundleLabels: [UUID: String] = [:]
    private var ticketLabels: [UUID: String] = [:]
    private var liveBundles: Set<UUID> = []
    private var liveTickets: Set<UUID> = []
    private var publications: [UUID: (String, Publication)] = [:]

    init(input: Input) {
        self.input = input
    }

    var intent: WorkspaceCodemapOperationPresentationIntent {
        .exact(fileIDs: [uuid(1), uuid(2)], completeRootSet: false)
    }

    var rootNames: [UUID: String] {
        [uuid(10): "a", uuid(20): "b"]
    }

    func advance(_ duration: Duration) {
        let elapsed = durationMilliseconds(duration)
        precondition(elapsed >= 0)
        ContinuousClock.active.milliseconds += elapsed
        trace.append("wait \(elapsed)ms now=\(ContinuousClock.active.milliseconds)")
    }

    func releaseBundle(_ id: UUID) {
        precondition(liveBundles.remove(id) != nil)
        trace.append("release bundle=" + bundleLabels[id]!)
    }

    func releaseTicket(_ id: UUID) {
        precondition(liveTickets.remove(id) != nil)
        trace.append("release ticket=" + ticketLabels[id]!)
    }

    func beforePublication(_ receipt: WorkspaceCodemapOperationPresentationPublicationReceipt) {
        trace.append("beforePublication " + publications[receipt.requestID]!.0)
    }

    func publicationDisposition(
        _ receipt: WorkspaceCodemapOperationPresentationPublicationReceipt,
        rootScope: WorkspaceLookupRootScope
    ) -> WorkspaceCodemapOperationPublicationDisposition {
        precondition(rootScope == .allLoaded && receipt.rootScope == rootScope)
        let (label, publication) = publications[receipt.requestID]!
        trace.append("publication \(label)=\(publication.rawValue)")
        switch publication {
        case .current: return .current
        case .stale: return .stale(.rootScope)
        case .absent: preconditionFailure("An absent receipt cannot be revalidated")
        }
    }

    func make(
        ownership: WorkspaceCodemapOperationPresentationOwnership,
        clock: ContinuousClock,
        deadline: ContinuousClock.Instant,
        waiter: WorkspaceCodemapPresentationWaiter
    ) async throws -> ScriptedPresentation {
        let attempt = input.attempts[attemptCount]
        precondition(attempt.advanceMilliseconds >= 0)
        attemptCount += 1
        let prefix = "a\(attemptCount)"
        let now = clock.now.milliseconds
        trace.append("make#\(attemptCount) now=\(now) deadline=\(deadline.milliseconds)"
            + " remaining=\(deadline.milliseconds - now)")
        let ticket = await retainResources(ownership)
        if attempt.advanceMilliseconds > 0 {
            try await waiter.sleep(.milliseconds(attempt.advanceMilliseconds))
        }
        switch attempt.exit {
        case .error: throw FixtureFailure.scriptedMake
        case .cancellation: throw CancellationError()
        case .value: break
        }
        let entries = attempt.entries.enumerated().map { index, path in
            WorkspaceCodemapOperationRenderedEntry(
                bundleID: uuid(attemptCount * 100 + 11), fileID: uuid(index + 1),
                rootEpoch: String(path.prefix(1)), artifactKey: path,
                logicalPath: WorkspaceCodemapLogicalPresentationPath(displayPath: path),
                text: "scripted", tokenCount: 1
            )
        }
        let issues: [WorkspaceCodemapOperationIssue] = attempt.issues.map { issue in
            switch issue {
            case .renderStale: return .renderUnavailable(rootEpoch: "a", reason: .staleCurrentness(ticket))
            case .noRenderable: return .renderUnavailable(rootEpoch: "a", reason: .noRenderableCodemap(uuid(1)))
            }
        }
        let receipt: WorkspaceCodemapOperationPresentationPublicationReceipt?
        if attempt.publication == .absent {
            receipt = nil
        } else {
            let id = uuid(attemptCount)
            publications[id] = ("p\(attemptCount)", attempt.publication)
            receipt = WorkspaceCodemapOperationPresentationPublicationReceipt(
                requestID: id, rootScope: .allLoaded, logicalRootDisplayNamesByRootID: rootNames,
                completeRootSet: false, completeRootCatalogs: [], candidates: [],
                demandTickets: [], bundles: [], automaticReceipt: nil
            )
        }
        trace.append("made \(prefix) entries=[\(attempt.entries.joined(separator: ","))]"
            + " issues=[\(issues.map(issueLabel).joined(separator: ","))]")
        return ScriptedPresentation(entries: entries, issues: issues, receipt: receipt)
    }

    func retainResources(
        _ ownership: WorkspaceCodemapOperationPresentationOwnership
    ) async -> WorkspaceCodemapArtifactDemandTicket {
        let prefix = "a\(attemptCount)"
        let ticket = WorkspaceCodemapArtifactDemandTicket(
            retainID: uuid(attemptCount * 100 + 1), requestID: uuid(attemptCount),
            rootEpoch: "a", fileID: uuid(1), requestGeneration: 1,
            catalogGeneration: 1, pathGeneration: 1, ingressGeneration: 1
        )
        var tickets = [ticket]
        tickets.append(WorkspaceCodemapArtifactDemandTicket(
            retainID: uuid(attemptCount * 100 + 2), requestID: uuid(attemptCount),
            rootEpoch: "b", fileID: uuid(2), requestGeneration: 1,
            catalogGeneration: 1, pathGeneration: 1, ingressGeneration: 1
        ))
        for (index, ticket) in tickets.enumerated().reversed() {
            ticketLabels[ticket.retainID] = prefix + ".t\(index + 1)"
            liveTickets.insert(ticket.retainID)
            await ownership.record(WorkspaceCodemapArtifactDemandOwnedResult(
                result: .pending(ticket), ownership: index == 0 ? .joined(ticket) : .created(ticket)
            ))
        }
        for index in 1 ... 2 {
            let id = uuid(attemptCount * 100 + 10 + index)
            bundleLabels[id] = prefix + ".b\(index)"
            liveBundles.insert(id)
            await ownership.record(WorkspaceCodemapFrozenPresentationBundle(id: id))
        }
        trace.append("own \(prefix) tickets=[t2,t1] bundles=[b1,b2]")
        return ticket
    }

    func operate(context: String, presentation: WorkspaceCodemapOperationPresentation) throws -> OperationValue {
        let value = OperationValue(
            call: operations.count + 1, context: context,
            entries: presentation.orderedEntries.map { $0.logicalPath.displayPath },
            coverage: coverageLabel(presentation.coverage), issues: presentation.issues.map(issueLabel),
            receipt: presentation.publicationReceipt.map { publications[$0.requestID]!.0 }
        )
        operations.append(value)
        trace.append("operation#\(value.call)")
        switch input.operation {
        case .value: return value
        case .error: throw FixtureFailure.scriptedOperation
        case .cancelTask:
            withUnsafeCurrentTask { $0!.cancel() }
            return value
        }
    }

    func run() async -> Output {
        ContinuousClock.active = FixtureTime()
        let coordinator = OriginalCoordinator(
            store: WorkspaceFileContextStore(runtime: self), policy: .default,
            waiter: WorkspaceCodemapPresentationWaiter { duration in await self.advance(duration) },
            beforePublicationRevalidation: { receipt in self.beforePublication(receipt) }, runtime: self
        )
        let caller: String
        let outcome: String
        switch input.caller {
        case .selection: caller = "selection:nil"
        case let .alternateExport(count): caller = "alternateExport:\(count)"
        }
        do {
            let value = try await invoke(coordinator)
            outcome = "operation#\(value.call)"
        } catch is CancellationError {
            outcome = "error:CancellationError"
        } catch FixtureFailure.scriptedMake {
            outcome = "error:scriptedMake"
        } catch FixtureFailure.scriptedOperation {
            outcome = "error:scriptedOperation"
        } catch {
            preconditionFailure("Unexpected fixture failure: \(error)")
        }
        precondition(attemptCount == input.attempts.count, "Unused scripted attempts")
        let resources = liveBundles.count + liveTickets.count
        precondition(resources == 0, "Ownership was not released")
        return Output(
            name: input.name, caller: caller, trace: trace, operations: operations, outcome: outcome,
            clockCreations: ContinuousClock.active.clockCreations, remainingResources: resources
        )
    }

    func invoke(_ coordinator: OriginalCoordinator) async throws -> OperationValue {
        switch input.caller {
        case .selection:
            return try await coordinator.withPresentation(
                for: intent, rootScope: .allLoaded, logicalRootDisplayNamesByRootID: rootNames
            ) { presentation in
                try self.operate(context: "selection", presentation: presentation)
            }
        case let .alternateExport(count):
            return try await coordinator.withPresentation(
                prepareAttempt: {
                    self.preparedCount += 1
                    let context = "alternate#\(self.preparedCount)"
                    self.trace.append("prepare " + context + " requested=\(count)")
                    return WorkspaceCodemapPresentationAttempt(
                        context: context, intent: self.intent, rootScope: .allLoaded,
                        logicalRootDisplayNamesByRootID: self.rootNames, requestedCodemapCount: count
                    )
                }, operation: { context, presentation in
                    try self.operate(context: context, presentation: presentation)
                }
            )
        }
    }
}

extension OriginalCoordinator {
    // swiftlint:disable:next function_parameter_count
    private func makePresentation(
        intent: WorkspaceCodemapOperationPresentationIntent,
        rootScope: WorkspaceLookupRootScope,
        logicalRootDisplayNamesByRootID: [UUID: String],
        ownership: WorkspaceCodemapOperationPresentationOwnership,
        clock: ContinuousClock,
        deadline: ContinuousClock.Instant
    ) async throws -> WorkspaceCodemapOperationPresentation {
        precondition(intent == runtime.intent && rootScope == .allLoaded && logicalRootDisplayNamesByRootID == runtime
            .rootNames)
        let scripted = try await runtime.make(
            ownership: ownership, clock: clock, deadline: deadline, waiter: waiter
        )
        return WorkspaceCodemapOperationPresentation(
            orderedEntries: scripted.entries, coverage: coverage(for: scripted.entries, issues: scripted.issues),
            issues: scripted.issues, publicationReceipt: scripted.receipt
        )
    }
}

@main private enum FixtureMain {
    @MainActor static func main() async throws {
        let inputs = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
        var outputs: [Output] = []
        for input in inputs {
            let runtime = FixtureRuntime(input: input)
            let output = await Task { @MainActor in await runtime.run() }.value
            outputs.append(output)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try FileHandle.standardOutput.write(encoder.encode(outputs))
    }
}
