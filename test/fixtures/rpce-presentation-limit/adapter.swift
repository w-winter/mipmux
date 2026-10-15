import Foundation

// Fixture labels stand for complete root epochs; no root authority is constructed.
typealias WorkspaceCodemapRootEpoch = String
typealias WorkspaceCodemapLogicalPresentationPath = String

struct WorkspaceCodemapArtifactDemandTicket: Hashable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let fileID: UUID
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapArtifactDemandUnavailableReason: Equatable {
    case registrationFailed
    case staleCurrentness
}

enum FixtureReadyOutcome {
    case ready
    case readyNoSymbols
}

/// Outcome labels replace real snapshots and handles; artifact acquisition is not executed.
struct WorkspaceCodemapArtifactDemandReady {
    let ticket: WorkspaceCodemapArtifactDemandTicket
    let outcome: FixtureReadyOutcome
}

struct WorkspaceCodemapFrozenPresentationBundle {}

struct FixtureCandidate {
    let fileID: UUID
    let rootEpoch: WorkspaceCodemapRootEpoch
    let logicalPath: WorkspaceCodemapLogicalPresentationPath
}

struct FixtureDemandBatch {
    let resultsByFileID: [UUID: WorkspaceCodemapArtifactDemandResult]
}

enum FixtureIssue {
    case unavailable(fileID: UUID, reason: WorkspaceCodemapArtifactDemandUnavailableReason)
    case pending(fileID: UUID, ticket: WorkspaceCodemapArtifactDemandTicket)
}

struct FixtureInputs: Decodable {
    let directGuardCases: [DirectGuardInput]
    let groupedReadyCases: [GroupedReadyInput]
}

struct DirectGuardInput: Decodable {
    let name: String
    let requestCount: Int
}

struct GroupedReadyInput: Decodable {
    let name: String
    let roots: [RootInput]
}

struct RootInput: Decodable {
    let epoch: String
    let ready: Int
    let readyNoSymbols: Int
}

enum GuardObservation: Encodable {
    case admittedToModeledSuccess
    case unavailable(WorkspaceCodemapPresentationFreezeUnavailableReason)

    private enum CodingKeys: String, CodingKey {
        case status, reason, limit, selectionIssueDisposition
    }

    init(_ disposition: WorkspaceCodemapPresentationFreezeDisposition) {
        switch disposition {
        case .ready:
            self = .admittedToModeledSuccess
        case let .unavailable(reason):
            self = .unavailable(reason)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .admittedToModeledSuccess:
            try container.encode("admittedToModeledSuccess", forKey: .status)
        case let .unavailable(reason):
            try container.encode("unavailable", forKey: .status)
            try container.encode(
                OriginalSelectionCore.fixtureClassification(reason),
                forKey: .selectionIssueDisposition
            )
            switch reason {
            case .emptyRequest:
                try container.encode("emptyRequest", forKey: .reason)
            case let .entryLimitExceeded(limit):
                try container.encode("entryLimitExceeded", forKey: .reason)
                try container.encode(limit, forKey: .limit)
            default:
                preconditionFailure("The compiled entry guard cannot return this reason")
            }
        }
    }
}

struct DirectGuardObservation: Encodable {
    let name: String
    let requestCount: Int
    let entryGuard: GuardObservation
}

struct RootObservation: Encodable {
    let epoch: String
    let readyInputCount: Int
    let readyNoSymbolsInputCount: Int
    let freezeRequestCount: Int
    let entryGuard: GuardObservation
}

struct GroupedReadyObservation: Encodable {
    let name: String
    let totalReadyInputCount: Int
    let roots: [RootObservation]
}

struct FixtureOutput: Encodable {
    let directGuardCases: [DirectGuardObservation]
    let groupedReadyCases: [GroupedReadyObservation]
}

private func ticket(epoch: String, ordinal: Int) -> WorkspaceCodemapArtifactDemandTicket {
    let fileID = UUID(uuidString: String(format: "00000000-0000-0000-0000-%012x", ordinal))!
    return WorkspaceCodemapArtifactDemandTicket(rootEpoch: epoch, fileID: fileID)
}

@main
enum FixtureMain {
    static func main() throws {
        let input = try JSONDecoder().decode(
            FixtureInputs.self, from: FileHandle.standardInput.readDataToEndOfFile()
        )
        let store = OriginalEntryGuard()
        let direct = input.directGuardCases.map { observeDirect($0, store: store) }
        let grouped = input.groupedReadyCases.map { observeGrouped($0, store: store) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let output = FixtureOutput(directGuardCases: direct, groupedReadyCases: grouped)
        try FileHandle.standardOutput.write(encoder.encode(output))
    }

    static func observeDirect(_ testCase: DirectGuardInput, store: OriginalEntryGuard) -> DirectGuardObservation {
        precondition(testCase.requestCount >= 0)
        let requests = (0 ..< testCase.requestCount).map { index in
            WorkspaceCodemapPresentationRequest(
                ticket: ticket(epoch: "a@1", ordinal: index + 1),
                logicalPath: "file-\(index).swift"
            )
        }
        return DirectGuardObservation(
            name: testCase.name, requestCount: requests.count,
            entryGuard: GuardObservation(store.freezeCodemapPresentation(requests))
        )
    }

    static func observeGrouped(_ testCase: GroupedReadyInput, store: OriginalEntryGuard) -> GroupedReadyObservation {
        var candidates: [FixtureCandidate] = []
        var results: [UUID: WorkspaceCodemapArtifactDemandResult] = [:]
        for root in testCase.roots {
            precondition(root.ready >= 0 && root.readyNoSymbols >= 0)
            let outcomes = Array(repeating: FixtureReadyOutcome.ready, count: root.ready)
                + Array(repeating: .readyNoSymbols, count: root.readyNoSymbols)
            for outcome in outcomes {
                let ticket = ticket(epoch: root.epoch, ordinal: candidates.count + 1)
                candidates.append(FixtureCandidate(
                    fileID: ticket.fileID, rootEpoch: root.epoch,
                    logicalPath: "file-\(candidates.count).swift"
                ))
                results[ticket.fileID] = .ready(WorkspaceCodemapArtifactDemandReady(
                    ticket: ticket, outcome: outcome
                ))
            }
        }
        let requestsByRoot = OriginalGrouping.group(
            candidates: candidates, demandBatch: FixtureDemandBatch(resultsByFileID: results)
        )
        // Only the grouping body is original; this synchronous root loop models its caller.
        let roots = requestsByRoot.keys.sorted().map { epoch in
            let requests = requestsByRoot[epoch]!
            let counts = testCase.roots.filter { $0.epoch == epoch }
            return RootObservation(
                epoch: epoch,
                readyInputCount: counts.reduce(0) { $0 + $1.ready },
                readyNoSymbolsInputCount: counts.reduce(0) { $0 + $1.readyNoSymbols },
                freezeRequestCount: requests.count,
                entryGuard: GuardObservation(store.freezeCodemapPresentation(requests))
            )
        }
        return GroupedReadyObservation(
            name: testCase.name, totalReadyInputCount: candidates.count, roots: roots
        )
    }
}
