import Foundation

typealias WorkspaceCodemapRootEpoch = String
typealias CodeMapArtifactKey = String
// swiftlint:disable:next type_name
typealias WorkspaceCodemapOperationPublicationStaleReason = Never

struct WorkspaceCodemapLogicalPresentationPath: Equatable {
    let displayPath: String
}

struct WorkspaceCodemapArtifactDemandTicket: Hashable {
    let rootEpoch: WorkspaceCodemapRootEpoch
    let fileID: UUID
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapArtifactDemandUnavailableReason: Equatable {
    case registrationFailed
    case staleCurrentness
}

struct WorkspaceCodemapArtifactDemandReady {
    let entry: WorkspaceCodemapFrozenPresentationEntry
    var ticket: WorkspaceCodemapArtifactDemandTicket {
        entry.ticket
    }
}

// swiftlint:disable:next type_name
enum WorkspaceCodemapAutomaticSelectionAggregateCoverage: Equatable {
    // swiftlint:disable:next identifier_name
    case ok, partial, pending, unavailable
}

struct FixtureSyntaxArtifact {
    let imports: [String]
    let apiDescription: String
}

enum CodeMapSyntaxArtifactOutcome {
    case ready(FixtureSyntaxArtifact)
    case readyNoSymbols, oversize, decodeFailed, parseFailed
}

struct FixtureSyntaxHandle {
    let key: CodeMapArtifactKey
    let outcome: CodeMapSyntaxArtifactOutcome
}

enum FixtureHandleError: Error { case revoked }
// swiftlint:disable:next type_name
enum WorkspaceCodemapLiveOverlayBundleAccessError: Error { case entryUnavailable }

final class FixtureHandleState {
    let fileID: UUID
    let handle: FixtureSyntaxHandle
    let access: HandleInput

    init(fileID: UUID, handle: FixtureSyntaxHandle, access: HandleInput) {
        self.fileID = fileID
        self.handle = handle
        self.access = access
    }

    /// A synchronous injected access result replaces lock-backed storage and lease retention.
    func withHandle<T>(
        fileID: UUID, retainedLeaseOwner _: Never?,
        _ body: (FixtureSyntaxHandle) throws -> T
    ) throws -> T? {
        precondition(fileID == self.fileID)
        if access == .revoked { throw FixtureHandleError.revoked }
        return try body(handle)
    }
}

struct WorkspaceCodemapLiveFrozenArtifactHandle {
    let fileID: UUID
    let state: FixtureHandleState
    let retainedLeaseOwner: Never? = nil
}

struct CodemapDemandRecord {
    let ticket: WorkspaceCodemapArtifactDemandTicket
    let result: WorkspaceCodemapArtifactDemandResult
}

struct FixturePresentationRecord {
    let id: WorkspaceCodemapFrozenPresentationBundleID
    let rootEpoch: WorkspaceCodemapRootEpoch
    let entries: [WorkspaceCodemapFrozenPresentationEntry]
    let handles: [WorkspaceCodemapLiveFrozenArtifactHandle]
}

struct FixtureSession {
    let presentationRecordsByID: [WorkspaceCodemapFrozenPresentationBundleID: FixturePresentationRecord]
    let demandsByFileID: [UUID: CodemapDemandRecord]
}

struct FixtureSeed {
    let entry: WorkspaceCodemapFrozenPresentationEntry
    let handle: WorkspaceCodemapLiveFrozenArtifactHandle
    let currentness: CurrentnessInput
}

actor FixtureStore {
    let seeds: [UUID: FixtureSeed]
    var codemapSessionsByRootEpoch: [WorkspaceCodemapRootEpoch: FixtureSession] = [:]
    var currentnessChecks: [UUID: Int] = [:]

    init(seeds: [UUID: FixtureSeed]) {
        self.seeds = seeds
    }

    /// Construct retained ready bundles directly. The original freeze function is not run.
    func freezeCodemapPresentation(
        _ requests: [WorkspaceCodemapPresentationRequest]
    ) -> WorkspaceCodemapPresentationFreezeDisposition {
        precondition(!requests.isEmpty)
        let root = requests[0].ticket.rootEpoch
        let entries = requests.map { request in
            let entry = seeds[request.ticket.fileID]!.entry
            precondition(entry.ticket == request.ticket && entry.logicalPath == request.logicalPath)
            precondition(entry.ticket.rootEpoch == root)
            return entry
        }
        let handles = entries.map { seeds[$0.ticket.fileID]!.handle }
        let bundle = WorkspaceCodemapFrozenPresentationBundle(
            rootEpoch: root, entries: entries, handles: handles
        )
        let record = FixturePresentationRecord(
            id: bundle.id, rootEpoch: root, entries: entries, handles: handles
        )
        let demands = Dictionary(uniqueKeysWithValues: entries.map { entry in
            (entry.ticket.fileID, CodemapDemandRecord(
                ticket: entry.ticket, result: .ready(WorkspaceCodemapArtifactDemandReady(entry: entry))
            ))
        })
        codemapSessionsByRootEpoch[root] = FixtureSession(
            presentationRecordsByID: [bundle.id: record], demandsByFileID: demands
        )
        return .ready(bundle)
    }

    /// Currentness changes are scripted at render time, after the modeled freeze succeeds.
    func codemapDemandIsCurrent(_ ticket: WorkspaceCodemapArtifactDemandTicket) -> Bool {
        let checks = currentnessChecks[ticket.fileID, default: 0] + 1
        currentnessChecks[ticket.fileID] = checks
        switch seeds[ticket.fileID]!.currentness {
        case .current: return true
        case .stale: return false
        case .staleOnRevalidation: return checks == 1
        }
    }

    /// Entry equality replaces production identity, snapshot and generation matching.
    func codemapPresentationReadyMatches(
        _ ready: WorkspaceCodemapArtifactDemandReady,
        demandRecord: CodemapDemandRecord,
        entry: WorkspaceCodemapFrozenPresentationEntry
    ) -> Bool {
        ready.entry == entry && demandRecord.ticket == entry.ticket
    }
}

struct FixtureCandidate {
    let fileID: UUID
    let rootEpoch: WorkspaceCodemapRootEpoch
    let logicalPath: WorkspaceCodemapLogicalPresentationPath
}

struct FixtureDemandBatch {
    let resultsByFileID: [UUID: WorkspaceCodemapArtifactDemandResult]
}

actor FixtureOwnership {
    /// The fixture store retains all handles for the entire invocation.
    func record(_: WorkspaceCodemapFrozenPresentationBundle) {}
}

enum FixturePhase { case freeze, render }

func workspaceCodemapRootEpochPrecedes(_ lhs: String, _ rhs: String) -> Bool {
    lhs < rhs
}

struct WorkspaceFileRecord {
    let id: UUID
    let name: String
    let displayPath: String
}

enum SyntaxManager {
    static func supportsCodeMap(fileExtension: String) -> Bool {
        precondition(fileExtension == "swift", "Only supported Swift labels are fixture inputs")
        return true
    }
}

struct WorkspaceCodemapOperationPresentation {
    let orderedEntries: [WorkspaceCodemapOperationRenderedEntry]
    let renderedEntriesByFileID: [UUID: WorkspaceCodemapOperationRenderedEntry]
    let issues: [WorkspaceCodemapOperationIssue]
    let coverage: WorkspaceCodemapOperationPresentationCoverage
    let bundleReceipts: [WorkspaceCodemapOperationPresentationBundleReceipt]

    init(
        entries: [WorkspaceCodemapOperationRenderedEntry], issues: [WorkspaceCodemapOperationIssue],
        coverage: WorkspaceCodemapOperationPresentationCoverage,
        bundleReceipts: [WorkspaceCodemapOperationPresentationBundleReceipt]
    ) {
        orderedEntries = entries
        renderedEntriesByFileID = Dictionary(uniqueKeysWithValues: entries.map { ($0.fileID, $0) })
        self.issues = issues
        self.coverage = coverage
        self.bundleReceipts = bundleReceipts
    }
}

enum ArtifactInput: String, Decodable { case ready, readyNoSymbols }
enum CurrentnessInput: String, Decodable { case current, stale, staleOnRevalidation }
enum HandleInput: String, Decodable { case valid, revoked }

struct FileInput: Decodable {
    let name: String
    let outcome: ArtifactInput
    let currentness: CurrentnessInput
    let handle: HandleInput
}

struct RootInput: Decodable {
    let root: String
    let files: [FileInput]
}

struct CaseInput: Decodable {
    let name: String
    let roots: [RootInput]
}

enum RootObservation: Encodable {
    case ready(root: String, rendered: [String])
    case unavailable(root: String, rendered: [String], reason: String, file: String)

    private enum CodingKeys: String, CodingKey { case root, rendered, status, reason, file }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .ready(root, rendered):
            try container.encode(root, forKey: .root)
            try container.encode(rendered, forKey: .rendered)
            try container.encode("ready", forKey: .status)
        case let .unavailable(root, rendered, reason, file):
            try container.encode(root, forKey: .root)
            try container.encode(rendered, forKey: .rendered)
            try container.encode("unavailable", forKey: .status)
            try container.encode(reason, forKey: .reason)
            try container.encode(file, forKey: .file)
        }
    }
}

struct CaseObservation: Encodable {
    let name: String
    let roots: [RootObservation]
    let pending: [String]
    let unmapped: [String]
}

@main
enum FixtureMain {
    static func main() async throws {
        let inputs = try JSONDecoder().decode(
            [CaseInput].self, from: FileHandle.standardInput.readDataToEndOfFile()
        )
        var observations: [CaseObservation] = []
        for input in inputs {
            try observations.append(await observe(input))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try FileHandle.standardOutput.write(encoder.encode(observations))
    }

    static func observe(_ input: CaseInput) async throws -> CaseObservation {
        var seeds: [UUID: FixtureSeed] = [:]
        var candidates: [FixtureCandidate] = []
        var results: [UUID: WorkspaceCodemapArtifactDemandResult] = [:]
        var files: [WorkspaceFileRecord] = []
        for root in input.roots {
            for file in root.files {
                let id = UUID(uuidString: String(format: "00000000-0000-0000-0000-%012x", files.count + 1))!
                let ticket = WorkspaceCodemapArtifactDemandTicket(rootEpoch: root.root, fileID: id)
                let path = WorkspaceCodemapLogicalPresentationPath(displayPath: root.root + "/" + file.name)
                let syntaxOutcome: CodeMapSyntaxArtifactOutcome = file.outcome == .ready
                    ? .ready(FixtureSyntaxArtifact(imports: [], apiDescription: "\nfunc f()\n"))
                    : .readyNoSymbols
                let key = path.displayPath
                let entry = WorkspaceCodemapFrozenPresentationEntry(
                    ticket: ticket, logicalPath: path, artifactKey: key,
                    outcome: WorkspaceCodemapLiveArtifactOutcome(syntaxOutcome)
                )
                let state = FixtureHandleState(
                    fileID: id, handle: FixtureSyntaxHandle(key: key, outcome: syntaxOutcome),
                    access: file.handle
                )
                seeds[id] = FixtureSeed(
                    entry: entry, handle: WorkspaceCodemapLiveFrozenArtifactHandle(fileID: id, state: state),
                    currentness: file.currentness
                )
                candidates.append(FixtureCandidate(fileID: id, rootEpoch: root.root, logicalPath: path))
                results[id] = .ready(WorkspaceCodemapArtifactDemandReady(entry: entry))
                files.append(WorkspaceFileRecord(id: id, name: file.name, displayPath: path.displayPath))
            }
        }
        let presentation = try await OriginalCoordinator().run(
            candidates: candidates, demandBatch: FixtureDemandBatch(resultsByFileID: results),
            store: FixtureStore(seeds: seeds)
        )
        let roots = input.roots.map { observeRoot($0, presentation: presentation, files: files) }
        let diagnostics = await OriginalSelectionCore.missingCodemapDiagnostics(
            for: files, presentation: presentation, displayPath: { $0.displayPath }
        )
        return CaseObservation(
            name: input.name, roots: roots, pending: diagnostics.pendingPaths, unmapped: diagnostics.unmappedPaths
        )
    }

    static func observeRoot(
        _ root: RootInput, presentation: WorkspaceCodemapOperationPresentation, files: [WorkspaceFileRecord]
    ) -> RootObservation {
        let rendered = presentation.orderedEntries.filter { $0.rootEpoch == root.root }
            .map { $0.logicalPath.displayPath }
        let rootIssues = presentation.issues.filter { issue in
            guard case let .renderUnavailable(epoch, _) = issue else {
                preconditionFailure("Fixture inputs only exercise render failures")
            }
            return epoch == root.root
        }
        if let issue = rootIssues.first {
            guard case let .renderUnavailable(_, reason) = issue else { preconditionFailure() }
            let label: String
            let fileID: UUID
            switch reason {
            case let .noRenderableCodemap(id): label = "noRenderableCodemap"; fileID = id
            case let .staleCurrentness(ticket): label = "staleCurrentness"; fileID = ticket.fileID
            case let .handleRevoked(id): label = "handleRevoked"; fileID = id
            case .bundleNotRetained, .bundleMetadataMismatch:
                preconditionFailure("Fixture bundles have retained matching metadata")
            }
            return .unavailable(
                root: root.root, rendered: rendered, reason: label,
                file: files.first { $0.id == fileID }!.displayPath
            )
        }
        precondition(presentation.bundleReceipts.contains { $0.rootEpoch == root.root })
        return .ready(root: root.root, rendered: rendered)
    }
}
