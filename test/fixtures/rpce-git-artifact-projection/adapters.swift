import Foundation

struct GitRepoDescriptor { let repoKey: String; let rootPath: String }
struct VCSUncommittedFile: Codable {
    let path: String
    let status: String
    let additions: Int?
    let deletions: Int?
}

enum GitDiffEngine {
    struct GitDiffSnapshotBuildResult {
        let fingerprint: GitDiffFingerprint
        let changedFiles: [VCSUncommittedFile]
        // swiftlint:disable:next large_tuple
        let summary: (files: Int, insertions: Int, deletions: Int)
        let diffText: String?
        let perFile: [String: String]?
    }
}

enum MCPWindowToolName { static let git = "git" }
enum MCPProviderProjectionWorker {
    @MainActor static func run<T>(toolName _: String, phase _: String, body: () throws -> T) async rethrows -> T {
        try body()
    }
}

enum EditFlowPerf {
    enum Stage {
        // swiftlint:disable:next nesting
        enum Git {
            static let dtoConstruction = "dtoConstruction"
            static let mapLoadingExcerpting = "mapLoadingExcerpting"
        }
    }

    static func begin(_: String) -> Int? {
        nil
    }

    static func end(_: String, _: Int?) {}
}
