// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptC

// swiftlint:disable identifier_name line_length
enum SearchPathClause: Equatable {
    case exactFile(absPath: String, relPath: String, restrictedRootPath: String?)
    case exactFolder(absLower: String, relLower: String, restrictedRootPath: String?)
    case glob(pattern: String, restrictedRootPath: String?)
    case legacyPrefix(candidateLower: String)
}

struct SearchPathFilterSpec: Equatable {
    let caseInsensitive: Bool
    let clauses: [SearchPathClause]
}

struct FileSearchPathSnapshot {
    let standardizedFullPath: String
    let standardizedRelativePath: String
    let standardizedRootPath: String
    let clientDisplayPath: String
}

struct FileSearchPathIndexFilterResult: Equatable {
    let matchedSnapshotIndices: [Int]
    let visitedSnapshotCount: Int
    let cancelled: Bool
}

@inline(__always)
private func globMatch(_ pattern: String, _ text: String, _ caseInsensitive: Bool) -> Bool {
    let WM_CASEFOLD: UInt32 = 0x10
    let WM_WILDSTAR: UInt32 = 0x40
    let flags: UInt32 = (pattern.contains("**") ? WM_WILDSTAR : 0)
        | (caseInsensitive ? WM_CASEFOLD : 0)
    return pattern.withCString { pC in
        text.withCString { tC in
            repo_wildmatch(pC, tC, flags) == 0
        }
    }
}

private enum CompiledSearchPathClause {
    case exactFile(absPath: String, relPath: String, restrictedRootPath: String?)
    case exactFolder(absLower: String, absPrefix: String, relLower: String, relPrefix: String, restrictedRootPath: String?)
    case glob(pattern: String, restrictedRootPath: String?)
    case legacyPrefix(candidateLower: String, normalizedPrefix: String)
}

private func compileSearchPathClauses(_ clauses: [SearchPathClause]) -> [CompiledSearchPathClause] {
    clauses.map { clause in
        switch clause {
        case let .exactFile(absPath, relPath, restrictedRootPath):
            .exactFile(absPath: absPath, relPath: relPath, restrictedRootPath: restrictedRootPath)
        case let .exactFolder(absLower, relLower, restrictedRootPath):
            .exactFolder(
                absLower: absLower,
                absPrefix: absLower.hasSuffix("/") ? absLower : absLower + "/",
                relLower: relLower,
                relPrefix: relLower.hasSuffix("/") ? relLower : relLower + "/",
                restrictedRootPath: restrictedRootPath
            )
        case let .glob(pattern, restrictedRootPath):
            .glob(pattern: pattern, restrictedRootPath: restrictedRootPath)
        case let .legacyPrefix(candidateLower):
            .legacyPrefix(
                candidateLower: candidateLower,
                normalizedPrefix: candidateLower.hasSuffix("/") ? candidateLower : candidateLower + "/"
            )
        }
    }
}

/// Each snapshot lowercases a path view at most once, only when a clause needs it.
private struct SearchPathSnapshotView {
    let snapshot: FileSearchPathSnapshot
    private lazy var relLower = snapshot.standardizedRelativePath.lowercased()
    private lazy var fullLower = snapshot.standardizedFullPath.lowercased()
    private lazy var displayLower = snapshot.clientDisplayPath.lowercased()

    init(snapshot: FileSearchPathSnapshot) {
        self.snapshot = snapshot
    }

    mutating func matches(_ clause: CompiledSearchPathClause, caseInsensitive: Bool) -> Bool {
        let rel = snapshot.standardizedRelativePath
        let full = snapshot.standardizedFullPath
        let root = snapshot.standardizedRootPath
        switch clause {
        case let .exactFile(absPath, relPath, restrictedRootPath):
            if full == absPath { return true }
            return rel == relPath && (restrictedRootPath == nil || restrictedRootPath == root)
        case let .exactFolder(absLower, absPrefix, relLowerClause, relPrefix, restrictedRootPath):
            guard restrictedRootPath == nil || restrictedRootPath == root else { return false }
            let fl = fullLower
            if fl == absLower || fl.hasPrefix(absPrefix) { return true }
            let rl = relLower
            return rl == relLowerClause || rl.hasPrefix(relPrefix)
        case let .glob(pattern, restrictedRootPath):
            if let restrictedRootPath, restrictedRootPath != root { return false }
            return globMatch(pattern, snapshot.clientDisplayPath, caseInsensitive)
                || globMatch(pattern, rel, caseInsensitive)
                || globMatch(pattern, full, caseInsensitive)
        case let .legacyPrefix(candidateLower, normalizedPrefix):
            guard !candidateLower.isEmpty else { return false }
            let rl = relLower, dl = displayLower, fl = fullLower
            return rl == candidateLower || dl == candidateLower || fl == candidateLower
                || rl.hasPrefix(normalizedPrefix) || dl.hasPrefix(normalizedPrefix) || fl.hasPrefix(normalizedPrefix)
        }
    }
}

func filterPathIndicesResult(
    snapshots: [FileSearchPathSnapshot],
    spec: SearchPathFilterSpec
) -> FileSearchPathIndexFilterResult {
    var indices: [Int] = []
    indices.reserveCapacity(snapshots.count)
    let compiledClauses = compileSearchPathClauses(spec.clauses)
    var visitedSnapshotCount = 0
    var cancelled = false
    for index in snapshots.indices {
        if Task.isCancelled {
            cancelled = true
            break
        }
        visitedSnapshotCount += 1
        var view = SearchPathSnapshotView(snapshot: snapshots[index])
        for clause in compiledClauses where view.matches(clause, caseInsensitive: spec.caseInsensitive) {
            indices.append(index)
            break
        }
    }
    return FileSearchPathIndexFilterResult(
        matchedSnapshotIndices: indices,
        visitedSnapshotCount: visitedSnapshotCount,
        cancelled: cancelled
    )
}

// swiftlint:enable identifier_name line_length
