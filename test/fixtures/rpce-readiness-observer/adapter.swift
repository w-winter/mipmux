import Foundation

struct WorkspaceCodemapArtifactDemandTicket: Hashable {
    let fileID: UUID
    let retainID: UUID
}

struct WorkspaceCodemapArtifactDemandReady {
    let ticket: WorkspaceCodemapArtifactDemandTicket
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapArtifactDemandUnavailableReason {
    case busy(Int?)
    case staleCurrentness
}

enum WorkspaceCodemapArtifactDemandResult {
    case pending(WorkspaceCodemapArtifactDemandTicket)
    case ready(WorkspaceCodemapArtifactDemandReady)
    case unavailable(WorkspaceCodemapArtifactDemandUnavailableReason)
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapArtifactDemandOwnershipDisposition {
    case created(WorkspaceCodemapArtifactDemandTicket)
    case joined(WorkspaceCodemapArtifactDemandTicket)
    case notAcquired
}

// swiftlint:disable:next type_name
struct WorkspaceCodemapArtifactDemandOwnedResult {
    let result: WorkspaceCodemapArtifactDemandResult
    let ownership: WorkspaceCodemapArtifactDemandOwnershipDisposition
}

// swiftlint:disable:next type_name
typealias WorkspaceCodemapFrozenPresentationBundleID = UUID

struct WorkspaceCodemapFrozenPresentationBundle {
    let id: WorkspaceCodemapFrozenPresentationBundleID
}

enum CodeMapArtifactBuildPriority { case demand }

enum WorkspaceCodemapAutomaticSelectionIssue {
    enum Budget { case targetDemandLimit(attempted: Int, limit: Int) }
    case budget(Budget)
}

struct WorkObservation: Encodable {
    let file: String
    let retainCount: Int
    let workCompleted: Bool
    let taskCancellationRequested: Bool
    let waiterCount: Int
}

actor WorkspaceFileContextStore {
    private struct Record {
        let name: String
        let workGate = CodemapDemandCompletion()
        let completion = CodemapDemandCompletion()
        let observerStarted = CodemapDemandCompletion()
        var retainIDs: Set<UUID> = []
        var task: Task<Void, Never>?
        var workCompleted = false
    }

    private var records: [UUID: Record]

    init(files: [(UUID, String)]) {
        records = Dictionary(uniqueKeysWithValues: files.map { ($0.0, Record(name: $0.1)) })
    }

    func requestCodemapArtifactWithOwnership(
        forFileID fileID: UUID,
        priority _: CodeMapArtifactBuildPriority
    ) -> WorkspaceCodemapArtifactDemandOwnedResult {
        var record = records[fileID]!
        let created = record.task == nil
        if created {
            let gate = record.workGate
            record.task = Task {
                await gate.wait()
                guard !Task.isCancelled else { return }
                finishWork(fileID)
            }
        } else {
            precondition(!record.retainIDs.isEmpty, "Fixture does not re-request released records")
        }
        let ticket = WorkspaceCodemapArtifactDemandTicket(fileID: fileID, retainID: UUID())
        record.retainIDs.insert(ticket.retainID)
        records[fileID] = record
        return WorkspaceCodemapArtifactDemandOwnedResult(
            result: codemapArtifactDemandStatus(ticket),
            ownership: created ? .created(ticket) : .joined(ticket)
        )
    }

    func codemapArtifactDemandStatus(
        _ ticket: WorkspaceCodemapArtifactDemandTicket
    ) -> WorkspaceCodemapArtifactDemandResult {
        let record = records[ticket.fileID]!
        guard record.retainIDs.contains(ticket.retainID) else { return .unavailable(.staleCurrentness) }
        return record.workCompleted ? .ready(.init(ticket: ticket)) : .pending(ticket)
    }

    func waitForCodemapArtifactDemandChange(
        _ ticket: WorkspaceCodemapArtifactDemandTicket,
        deadline: ContinuousClock.Instant
    ) async -> WorkspaceCodemapArtifactDemandResult {
        let record = records[ticket.fileID]!
        precondition(record.retainIDs.contains(ticket.retainID))
        record.observerStarted.resolve()
        await record.completion.wait(until: deadline)
        return codemapArtifactDemandStatus(ticket)
    }

    func retryBusyCodemapArtifactDemand(
        _: WorkspaceCodemapArtifactDemandTicket,
        priority _: CodeMapArtifactBuildPriority
    ) -> WorkspaceCodemapArtifactDemandResult {
        preconditionFailure("Busy demand is outside this fixture")
    }

    func releaseCodemapPresentation(_: WorkspaceCodemapFrozenPresentationBundle) -> Bool {
        preconditionFailure("This fixture does not acquire presentation bundles")
    }

    /// Retain removal is a fixture model, not the extracted Store cancellation implementation.
    func cancelCodemapArtifactDemand(_ ticket: WorkspaceCodemapArtifactDemandTicket) -> Bool {
        var record = records[ticket.fileID]!
        precondition(record.retainIDs.remove(ticket.retainID) != nil)
        if record.retainIDs.isEmpty {
            record.task!.cancel()
            record.completion.resolve()
        }
        records[ticket.fileID] = record
        return true
    }

    private func finishWork(_ fileID: UUID) {
        precondition(!records[fileID]!.workCompleted)
        records[fileID]!.workCompleted = true
        records[fileID]!.completion.resolve()
    }

    func waitUntilObserved(_ fileID: UUID) async {
        await records[fileID]!.observerStarted.wait()
    }

    func allowWorkToComplete(_ fileID: UUID) {
        records[fileID]!.workGate.resolve()
    }

    func joinWork(_ fileID: UUID) async {
        await records[fileID]!.task!.value
    }

    func observations(_ fileIDs: [UUID]) -> [WorkObservation] {
        fileIDs.map { fileID in
            let record = records[fileID]!
            return WorkObservation(
                file: record.name, retainCount: record.retainIDs.count,
                workCompleted: record.workCompleted,
                taskCancellationRequested: record.task!.isCancelled,
                waiterCount: record.completion.waiterCount
            )
        }
    }
}

struct FixtureDemandBatch {
    let resultsByFileID: [UUID: WorkspaceCodemapArtifactDemandResult]
    let deadlineReached: Bool
    let defensiveRoundLimitReached: Bool
    let beforeRelease: [WorkObservation]
}

struct FixtureInput: Decodable {
    let productionWaitMilliseconds: Int
    let cases: [FixtureCase]
}

struct FixtureCase: Decodable {
    enum Behavior: String, Decodable { case ready, pendingDeadline, sharedPendingDeadline }
    let name: String
    let behavior: Behavior
    let waitMilliseconds: Int
    let files: [String]
}

enum FixtureFollowup: Encodable {
    case noIndependentOwner
    case independentlyRetainedWorkCompleted(
        statuses: [String], beforeOwnerRelease: [WorkObservation], afterOwnerRelease: [WorkObservation]
    )
}

struct FixtureOutput: Encodable {
    let name: String
    let waitMilliseconds: Int
    let statuses: [String]
    let deadlineReached: Bool
    let defensiveRoundLimitReached: Bool
    let beforeRelease: [WorkObservation]
    let afterPresentationRelease: [WorkObservation]
    let followup: FixtureFollowup
}

func statusName(_ result: WorkspaceCodemapArtifactDemandResult) -> String {
    switch result {
    case .pending: "pending"
    case .ready: "ready"
    case .unavailable: preconditionFailure("No unavailable result is expected in these cases")
    }
}

func finishIndependentOwner(
    store: WorkspaceFileContextStore, fileIDs: [UUID], tickets: [WorkspaceCodemapArtifactDemandTicket]
) async -> FixtureFollowup {
    for fileID in fileIDs {
        await store.allowWorkToComplete(fileID)
        await store.joinWork(fileID)
    }
    var statuses: [String] = []
    for ticket in tickets {
        statuses.append(statusName(await store.codemapArtifactDemandStatus(ticket)))
    }
    precondition(statuses.allSatisfy { $0 == "ready" })
    let beforeOwnerRelease = await store.observations(fileIDs)
    for ticket in tickets {
        _ = await store.cancelCodemapArtifactDemand(ticket)
    }
    let afterOwnerRelease = await store.observations(fileIDs)
    precondition(beforeOwnerRelease.allSatisfy { $0.workCompleted && $0.retainCount == 1 })
    precondition(afterOwnerRelease.allSatisfy { $0.workCompleted && $0.retainCount == 0 })
    return .independentlyRetainedWorkCompleted(
        statuses: statuses, beforeOwnerRelease: beforeOwnerRelease, afterOwnerRelease: afterOwnerRelease
    )
}

func validatePresentation(
    _ behavior: FixtureCase.Behavior, statuses: [String], batch: FixtureDemandBatch, afterRelease: [WorkObservation]
) {
    precondition(!batch.defensiveRoundLimitReached)
    precondition(afterRelease.allSatisfy { $0.waiterCount == 0 })
    switch behavior {
    case .ready:
        precondition(statuses.allSatisfy { $0 == "ready" } && !batch.deadlineReached)
        precondition(batch.beforeRelease.allSatisfy { $0.workCompleted && $0.retainCount == 1 })
        precondition(afterRelease.allSatisfy { $0.workCompleted && $0.retainCount == 0 })
    case .pendingDeadline:
        precondition(statuses.allSatisfy { $0 == "pending" } && batch.deadlineReached)
        precondition(batch.beforeRelease.allSatisfy { !$0.workCompleted && $0.retainCount == 1 })
        precondition(afterRelease.allSatisfy {
            !$0.workCompleted && $0.retainCount == 0 && $0.taskCancellationRequested
        })
    case .sharedPendingDeadline:
        precondition(statuses.allSatisfy { $0 == "pending" } && batch.deadlineReached)
        precondition(batch.beforeRelease.allSatisfy { !$0.workCompleted && $0.retainCount == 2 })
        precondition(afterRelease.allSatisfy {
            !$0.workCompleted && $0.retainCount == 1 && !$0.taskCancellationRequested
        })
    }
}

func run(_ input: FixtureCase) async throws -> FixtureOutput {
    let fileIDs = input.files.indices.map {
        UUID(uuidString: "00000000-0000-0000-0000-" + String(format: "%012x", $0 + 1))!
    }
    let store = WorkspaceFileContextStore(files: Array(zip(fileIDs, input.files)))
    let policy = WorkspaceCodemapPresentationRequestPolicy(maximumTotalWait: .milliseconds(input.waitMilliseconds))
    let coordinator = OriginalCoordinator(store: store, policy: policy, waiter: .production)
    var independentTickets: [WorkspaceCodemapArtifactDemandTicket] = []
    if input.behavior == .sharedPendingDeadline {
        for fileID in fileIDs {
            let owned = await store.requestCodemapArtifactWithOwnership(forFileID: fileID, priority: .demand)
            guard case let .created(ticket) = owned.ownership else { preconditionFailure("Expected new demand") }
            independentTickets.append(ticket)
        }
    }

    let presentation = Task { try await coordinator.observeFixture(fileIDs: fileIDs) }
    if input.behavior == .ready {
        for fileID in fileIDs {
            await store.waitUntilObserved(fileID)
            await store.allowWorkToComplete(fileID)
        }
    }
    let batch = try await presentation.value
    let afterRelease = await store.observations(fileIDs)
    let statuses = fileIDs.map { statusName(batch.resultsByFileID[$0]!) }
    validatePresentation(input.behavior, statuses: statuses, batch: batch, afterRelease: afterRelease)
    let followup: FixtureFollowup
    if input.behavior == .sharedPendingDeadline {
        // The gate opens only after the presentation and its release have returned.
        followup = await finishIndependentOwner(store: store, fileIDs: fileIDs, tickets: independentTickets)
    } else {
        followup = .noIndependentOwner
    }
    for fileID in fileIDs {
        await store.joinWork(fileID)
    }
    return FixtureOutput(
        name: input.name, waitMilliseconds: input.waitMilliseconds, statuses: statuses,
        deadlineReached: batch.deadlineReached, defensiveRoundLimitReached: batch.defensiveRoundLimitReached,
        beforeRelease: batch.beforeRelease, afterPresentationRelease: afterRelease, followup: followup
    )
}

@main struct FixtureMain {
    static func main() async throws {
        let input = try JSONDecoder().decode(FixtureInput.self, from: FileHandle.standardInput.readDataToEndOfFile())
        precondition(input.productionWaitMilliseconds == workspaceCodemapProductionDemandWaitMilliseconds)
        precondition(WorkspaceCodemapPresentationRequestPolicy.default.maximumTotalWait == .milliseconds(10000))
        var output: [FixtureOutput] = []
        for item in input.cases {
            try output.append(await run(item))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try FileHandle.standardOutput.write(encoder.encode(output))
    }
}
