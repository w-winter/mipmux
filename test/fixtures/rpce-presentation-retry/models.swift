import Foundation

typealias WorkspaceCodemapRootEpoch = String
typealias CodeMapArtifactKey = String
// swiftlint:disable:next type_name
typealias WorkspaceCodemapFrozenPresentationBundleID = UUID

struct WorkspaceCodemapLogicalPresentationPath: Hashable {
    let displayPath: String
}

struct WorkspaceCodemapFrozenPresentationEntry: Equatable {}
// swiftlint:disable:next type_name
struct WorkspaceCodemapAutomaticSelectionReceipt: Equatable {}
enum WorkspaceLookupRootScope: Equatable { case visibleWorkspace, allLoaded }
// swiftlint:disable:next type_name
enum WorkspaceCodemapAutomaticSelectionAggregateCoverage: Equatable {
    // swiftlint:disable:next identifier_name
    case ok, partial, pending, unavailable
}

enum WorkspaceCodemapAutomaticSelectionIssue: Equatable {
    enum Budget: Equatable { case targetDemandLimit(attempted: Int, limit: Int) }
    case budget(Budget)
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapArtifactDemandUnavailableReason: Equatable {
    case staleCurrentness, runtimeFailure
}

struct WorkspaceCodemapArtifactDemandReady {
    let ticket: WorkspaceCodemapArtifactDemandTicket
}

struct WorkspaceCodemapFrozenPresentationBundle {
    let id: WorkspaceCodemapFrozenPresentationBundleID
}

private let attosecondsPerMillisecond: Int64 = 1_000_000_000_000_000

private func durationMilliseconds(_ duration: Duration) -> Int64 {
    let parts = duration.components
    precondition(parts.attoseconds % attosecondsPerMillisecond == 0)
    return parts.seconds * 1000 + parts.attoseconds / attosecondsPerMillisecond
}

private struct FixtureInstant: Comparable {
    let milliseconds: Int64

    func advanced(by duration: Duration) -> Self {
        Self(milliseconds: milliseconds + durationMilliseconds(duration))
    }

    static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.milliseconds < rhs.milliseconds
    }
}

@MainActor private final class FixtureTime {
    var milliseconds: Int64 = 0
    var clockCreations = 0
}

/// This fixture clock shadows Swift.ContinuousClock so the original wrapper remains verbatim.
@MainActor private struct ContinuousClock {
    typealias Instant = FixtureInstant
    static var active = FixtureTime()
    private let time: FixtureTime

    init() {
        time = Self.active
        time.clockCreations += 1
    }

    var now: Instant {
        Instant(milliseconds: time.milliseconds)
    }
}

private enum Caller: Decodable {
    case selection
    case alternateExport(requestedCount: Int)
}

private enum ScriptIssue: String, Decodable { case renderStale, noRenderable }
private enum Publication: String, Decodable { case absent, current, stale }
private enum MakeExit: String, Decodable { case value, error, cancellation }
private enum OperationExit: String, Decodable { case value, error, cancelTask }

private struct Attempt: Decodable {
    let entries: [String]
    let issues: [ScriptIssue]
    let publication: Publication
    let advanceMilliseconds: Int64
    let exit: MakeExit
}

private struct Input: Decodable {
    let name: String
    let caller: Caller
    let operation: OperationExit
    let attempts: [Attempt]
}

private enum FixtureFailure: Error { case scriptedMake, scriptedOperation }

private struct OperationValue: Encodable {
    let call: Int
    let context: String
    let entries: [String]
    let coverage: String
    let issues: [String]
    let receipt: String?
}

private struct Output: Encodable {
    let name: String
    let caller: String
    let trace: [String]
    let operations: [OperationValue]
    let outcome: String
    let clockCreations: Int
    let remainingResources: Int
}

private func uuid(_ value: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", value))!
}

private func staleLabel(_ reason: WorkspaceCodemapOperationPublicationStaleReason) -> String {
    switch reason {
    case .rootScope: return "rootScope"
    case let .rootEpoch(root): return "rootEpoch:" + root
    default: preconditionFailure("Stale reason outside the scripted input domain")
    }
}

private func issueLabel(_ issue: WorkspaceCodemapOperationIssue) -> String {
    switch issue {
    case let .renderUnavailable(root, .staleCurrentness): return "renderStale:" + root
    case let .renderUnavailable(root, .noRenderableCodemap): return "noRenderable:" + root
    case let .publicationStale(reason): return "publicationStale:" + staleLabel(reason)
    default: preconditionFailure("Issue outside the scripted input domain")
    }
}

private func coverageLabel(_ coverage: WorkspaceCodemapOperationPresentationCoverage) -> String {
    switch coverage {
    case .complete: return "complete"
    case .partial: return "partial"
    case .pending: return "pending"
    case .unavailable: return "unavailable"
    }
}

private actor WorkspaceFileContextStore {
    let runtime: FixtureRuntime

    init(runtime: FixtureRuntime) {
        self.runtime = runtime
    }

    func releaseCodemapPresentation(_ bundle: WorkspaceCodemapFrozenPresentationBundle) async -> Bool {
        await runtime.releaseBundle(bundle.id)
        return true
    }

    func cancelCodemapArtifactDemand(_ ticket: WorkspaceCodemapArtifactDemandTicket) async -> Bool {
        await runtime.releaseTicket(ticket.retainID)
        return true
    }

    func revalidateCodemapOperationPresentationForPublication(
        _ receipt: WorkspaceCodemapOperationPresentationPublicationReceipt,
        rootScope: WorkspaceLookupRootScope
    ) async -> WorkspaceCodemapOperationPublicationDisposition {
        await runtime.publicationDisposition(receipt, rootScope: rootScope)
    }
}
