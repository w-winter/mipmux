// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct RPCEGitWorktreeListing {
    struct ResolvedWorktreeRecord: Equatable {
        let record: GitWorktreePorcelainRecord
        let pathURL: URL
        let layout: GitRepositoryLayout?
    }

    struct WorktreeAliasResolution: Equatable {
        let records: [ResolvedWorktreeRecord]
        let collapsedAliasCount: Int
    }

    enum WorktreeAliasConflict: String, Error, Equatable {
        case recordMetadata = "record_metadata"
        case repositoryLayout = "repository_layout"
    }

    private func normalizedWorktreeRecords(
        _ records: [GitWorktreePorcelainRecord],
        currentLayout: GitRepositoryLayout?,
        resolvedMainRoot: URL?
    ) -> [GitWorktreePorcelainRecord] {
        guard let currentLayout else { return records }
        let commonGitDirPath = currentLayout.commonDir.standardizedFileURL.path

        return records.compactMap { record in
            let recordPath = URL(fileURLWithPath: record.path).standardizedFileURL.path
            guard recordPath == commonGitDirPath else {
                return record
            }
            guard let resolvedMainRoot else {
                return nil
            }
            var normalized = record
            normalized.path = resolvedMainRoot.standardizedFileURL.path
            return normalized
        }
    }

    static func collapseEquivalentWorktreeAliases(
        _ records: [GitWorktreePorcelainRecord],
        resolveLayout: (URL) -> GitRepositoryLayout? = {
            GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: $0)
        }
    ) throws -> WorktreeAliasResolution {
        var resolvedRecords: [ResolvedWorktreeRecord] = []
        var indexByPath: [String: Int] = [:]
        var collapsedAliasCount = 0

        for sourceRecord in records {
            let sourceURL = URL(fileURLWithPath: sourceRecord.path)
            let pathURL = sourceURL.standardizedFileURL
            var record = sourceRecord
            record.path = pathURL.path
            let layout = resolveLayout(sourceURL).map(standardizedRepositoryLayout)
            let candidate = ResolvedWorktreeRecord(record: record, pathURL: pathURL, layout: layout)

            if let existingIndex = indexByPath[pathURL.path] {
                let existing = resolvedRecords[existingIndex]
                guard repositoryLayoutsAreEquivalent(existing.layout, candidate.layout) else {
                    throw WorktreeAliasConflict.repositoryLayout
                }
                guard existing.record == candidate.record else {
                    throw WorktreeAliasConflict.recordMetadata
                }
                collapsedAliasCount += 1
                continue
            }

            indexByPath[pathURL.path] = resolvedRecords.count
            resolvedRecords.append(candidate)
        }

        return WorktreeAliasResolution(
            records: resolvedRecords,
            collapsedAliasCount: collapsedAliasCount
        )
    }

    private static func repositoryLayoutsAreEquivalent(
        _ lhs: GitRepositoryLayout?,
        _ rhs: GitRepositoryLayout?
    ) -> Bool {
        guard let lhs, let rhs else { return false }
        return lhs.workTreeRoot.path == rhs.workTreeRoot.path
            && lhs.dotGitPath.path == rhs.dotGitPath.path
            && lhs.gitDir.path == rhs.gitDir.path
            && lhs.commonDir.path == rhs.commonDir.path
            && lhs.isWorktree == rhs.isWorktree
    }

    private static func standardizedRepositoryLayout(_ layout: GitRepositoryLayout) -> GitRepositoryLayout {
        GitRepositoryLayout(
            workTreeRoot: layout.workTreeRoot.standardizedFileURL,
            dotGitPath: layout.dotGitPath.standardizedFileURL,
            gitDir: layout.gitDir.standardizedFileURL,
            commonDir: layout.commonDir.standardizedFileURL,
            isWorktree: layout.isWorktree
        )
    }

    func resolve(layout: GitRepositoryLayout, resolvedMainRoot: URL?,
                 records: [GitWorktreePorcelainRecord]) throws -> (mainRoot: URL?, paths: [String]) {
        let normalized = normalizedWorktreeRecords(records.filter { !$0.isBare }, currentLayout: layout,
                                                   resolvedMainRoot: resolvedMainRoot)
        guard !normalized.isEmpty else { return (nil, []) }
        let aliases = try Self.collapseEquivalentWorktreeAliases(normalized)
        let discoveredMainRoot = aliases.records.first { resolvedRecord in
            resolvedRecord.layout.map { !$0.isLinkedWorktree } ?? false
        }.map(\.pathURL)
        let mainURL = resolvedMainRoot ?? discoveredMainRoot
        let mainRoot = aliases.records.first { resolvedRecord in
            if let layout = resolvedRecord.layout { return !layout.isLinkedWorktree }
            return mainURL?.path == resolvedRecord.pathURL.path && !resolvedRecord.record.isBare
        }?.pathURL
        return (mainRoot, aliases.records.map { $0.pathURL.path })
    }

    func resolveMainRoot(layout: GitRepositoryLayout, configValue: String) -> URL? {
        let rawPath = configValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawPath.isEmpty else { return nil }
        let candidate = if rawPath.hasPrefix("/") {
            URL(fileURLWithPath: rawPath).standardizedFileURL
        } else {
            layout.commonDir.appendingPathComponent(rawPath).standardizedFileURL
        }
        guard let candidateLayout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: candidate),
              !candidateLayout.isLinkedWorktree,
              candidateLayout.commonDir.standardizedFileURL.path == layout.commonDir.standardizedFileURL.path
        else { return nil }
        return candidate
    }
}
