// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct GitMaintenanceSnapshot {
    let repoKey: String
    let snapshotID: String
    let manifest: GitDiffSnapshotManifest
}

enum GitMaintenanceMetadata: String {
    case state = "maintenance.json"
    case index = "retention-index.json"
}

/// Every callback is bound to one admitted output root by ConfinedFiles.
struct GitSnapshotMaintenanceIO {
    let snapshots: () throws -> [GitMaintenanceSnapshot]
    let delete: (String, String) throws -> Bool
    let updateCurrent: (String) throws -> Void
    let cleanup: (Set<String>) throws -> Void
    let read: (GitMaintenanceMetadata) throws -> Data?
    let write: (GitMaintenanceMetadata, Data) throws -> Void
    let remove: (GitMaintenanceMetadata) throws -> Void
}

struct GitSnapshotMaintenanceInput {
    enum Action {
        case opened
        case published(String, String, Date)
        case closed(Set<UUID>)
    }

    let root: NativeHandle
    let action: Action

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "root", "action"])
        root = try NativeHandle(fields.value("root"))
        guard let raw = try fields.value("action") as? [String: Any], let kind = raw["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        switch kind {
        case "opened":
            _ = try WireObject(raw, keys: ["kind"])
            action = .opened
        case "published":
            let input = try WireObject(raw, keys: ["kind", "repoKey", "snapshotID", "generatedAt"])
            guard let date = try ISO8601DateFormatter().date(from: input.string("generatedAt")) else {
                throw BridgeFailure("nativeProtocolError")
            }
            action = try .published(input.string("repoKey"), input.string("snapshotID"), date)
        case "closed":
            let input = try WireObject(raw, keys: ["kind", "tabIDs"])
            guard let ids = try input.value("tabIDs") as? [String] else { throw BridgeFailure("nativeProtocolError") }
            let parsed = try ids.map { id in
                guard let value = UUID(uuidString: id) else { throw BridgeFailure("nativeProtocolError") }
                return value
            }
            action = .closed(Set(parsed))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }
}

final class RPCEGitSnapshotMaintenance {
    private struct Entry: Codable {
        let repoKey: String
        let snapshotID: String
        let generatedAt: Date
        var identity: String {
            "\(repoKey)\u{0}\(snapshotID)"
        }
    }

    private struct Index: Codable { let version: Int; let entries: [Entry] }
    private struct State: Codable { let version: Int; let lastCleanupAt: Date }
    private let maxSnapshotsPerWorkspace = 25
    private let maxAgeDays = 7
    private let minIntervalBetweenRuns: TimeInterval = 6 * 3600
    private let retentionIndexVersion = 1
    private let currentDataVersion = 2
    private var retentionEntriesByWorkspace: [String: [Entry]] = [:]

    func run(_ action: GitSnapshotMaintenanceInput.Action, workspace: String,
             storage: GitSnapshotMaintenanceIO) throws -> [String: Any] {
        switch action {
        case .opened:
            let state = try readState(storage)
            guard Date().timeIntervalSince(state.lastCleanupAt) >= minIntervalBetweenRuns else {
                return ["expiredDeleted": 0, "excessDeleted": 0]
            }
            let cutoff = Calendar.current.date(byAdding: .day, value: -maxAgeDays, to: Date()) ?? Date()
            let expired = deleteExpired(cutoff, storage: storage)
            var entries = rebuild(storage)
            let excess = enforceMaxCount(&entries, storage: storage)
            writeIndex(entries, workspace: workspace, storage: storage)
            write(State(version: currentDataVersion, lastCleanupAt: Date()), metadata: .state, storage: storage)
            return ["expiredDeleted": expired, "excessDeleted": excess]
        case let .published(repoKey, snapshotID, generatedAt):
            var entries = try retentionEntries(workspace, storage: storage)
            let published = Entry(repoKey: repoKey, snapshotID: snapshotID, generatedAt: generatedAt)
            entries.removeAll { $0.identity == published.identity }
            entries.append(published)
            _ = enforceMaxCount(&entries, storage: storage)
            writeIndex(entries, workspace: workspace, storage: storage)
            return [:]
        case let .closed(tabIDs):
            guard !tabIDs.isEmpty else { return ["deleted": 0] }
            let snapshots = (try? storage.snapshots()) ?? []
            var deletedCount = 0
            var affectedRepos = Set<String>()
            for entry in snapshots {
                if let tabID = entry.manifest.tabID, tabIDs.contains(tabID),
                   (try? storage.delete(entry.repoKey, entry.snapshotID)) == true {
                    deletedCount += 1
                    affectedRepos.insert(entry.repoKey)
                }
            }
            updateCurrent(affectedRepos, storage: storage)
            if deletedCount > 0 {
                retentionEntriesByWorkspace.removeValue(forKey: workspace)
                try? storage.remove(.index)
            }
            return ["deleted": deletedCount]
        }
    }

    private func deleteExpired(_ cutoffDate: Date, storage: GitSnapshotMaintenanceIO) -> Int {
        var deletedCount = 0
        var affectedRepos = Set<String>()
        for entry in (try? storage.snapshots()) ?? [] {
            if entry.manifest.generatedAt < cutoffDate,
               (try? storage.delete(entry.repoKey, entry.snapshotID)) == true {
                deletedCount += 1
                affectedRepos.insert(entry.repoKey)
            }
        }
        updateCurrent(affectedRepos, storage: storage)
        return deletedCount
    }

    private func enforceMaxCount(_ entries: inout [Entry], storage: GitSnapshotMaintenanceIO) -> Int {
        guard entries.count > maxSnapshotsPerWorkspace else { return 0 }
        let sorted = entries.sorted { lhs, rhs in
            if lhs.generatedAt != rhs.generatedAt { return lhs.generatedAt < rhs.generatedAt }
            if lhs.repoKey != rhs.repoKey { return lhs.repoKey < rhs.repoKey }
            return lhs.snapshotID < rhs.snapshotID
        }
        let toDelete = sorted.prefix(entries.count - maxSnapshotsPerWorkspace)
        var deletedCount = 0
        var deletedIdentities = Set<String>()
        var affectedRepos = Set<String>()
        for entry in toDelete where (try? storage.delete(entry.repoKey, entry.snapshotID)) == true {
            deletedCount += 1
            deletedIdentities.insert(entry.identity)
            affectedRepos.insert(entry.repoKey)
        }
        entries.removeAll { deletedIdentities.contains($0.identity) }
        updateCurrent(affectedRepos, storage: storage)
        return deletedCount
    }

    private func updateCurrent(_ affected: Set<String>, storage: GitSnapshotMaintenanceIO) {
        for key in affected {
            try? storage.updateCurrent(key)
        }
        try? storage.cleanup(affected)
    }

    private func retentionEntries(_ workspace: String, storage: GitSnapshotMaintenanceIO) throws -> [Entry] {
        if let cached = retentionEntriesByWorkspace[workspace] { return cached }
        if let data = try? storage.read(.index), let index = try? decoder().decode(Index.self, from: data) {
            guard index.version == retentionIndexVersion else { throw BridgeFailure("unsupportedSnapshotState") }
            retentionEntriesByWorkspace[workspace] = index.entries
            return index.entries
        }
        let rebuilt = rebuild(storage)
        writeIndex(rebuilt, workspace: workspace, storage: storage)
        return rebuilt
    }

    private func rebuild(_ storage: GitSnapshotMaintenanceIO) -> [Entry] {
        ((try? storage.snapshots()) ?? []).map {
            Entry(repoKey: $0.repoKey, snapshotID: $0.snapshotID, generatedAt: $0.manifest.generatedAt)
        }
    }

    private func readState(_ storage: GitSnapshotMaintenanceIO) throws -> State {
        guard let data = try? storage.read(.state), let state = try? decoder().decode(State.self, from: data) else {
            return State(version: currentDataVersion, lastCleanupAt: .distantPast)
        }
        guard state.version == currentDataVersion else { throw BridgeFailure("unsupportedSnapshotState") }
        return state
    }

    private func writeIndex(_ entries: [Entry], workspace: String, storage: GitSnapshotMaintenanceIO) {
        retentionEntriesByWorkspace[workspace] = entries
        write(Index(version: retentionIndexVersion, entries: entries), metadata: .index, storage: storage)
    }

    private func write(_ value: some Encodable, metadata: GitMaintenanceMetadata, storage: GitSnapshotMaintenanceIO) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        if let bytes = try? encoder.encode(value) { try? storage.write(metadata, bytes) }
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
