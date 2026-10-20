// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: immutable headless data bindings and private phases; retained policy and output.
// Preserve source identifiers, DTO nesting and copied algorithm layout.
// swiftlint:disable identifier_name nesting
import Foundation

enum ToolResultDTOs {
    struct WorktreeScopeDTO: Codable, Equatable {
        struct RootMappingDTO: Codable, Equatable {
            let logicalRootName: String
            let logicalRootPath: String
            let effectiveRootName: String
            let effectiveRootPath: String
            let worktreeID: String
            let worktreeName: String?
            let branch: String?
            let label: String?

            private enum CodingKeys: String, CodingKey {
                case logicalRootName = "logical_root_name"
                case logicalRootPath = "logical_root_path"
                case effectiveRootName = "effective_root_name"
                case effectiveRootPath = "effective_root_path"
                case worktreeID = "worktree_id"
                case worktreeName = "worktree_name"
                case branch
                case label
            }
        }

        let kind: String
        let displayIdentity: String
        let effectiveIdentity: String
        let rootMappings: [RootMappingDTO]
    }

    struct CodeStructureReplyDTO: Codable, Equatable {
        enum Status: String, Codable {
            case ok
            case partial
            case pending
            case unavailable
        }

        enum SeedState: String, Codable {
            case covered
            case pending
            case notIndexed = "not_indexed"
            case excluded
        }

        enum IndexState: String, Codable {
            case complete
            case indexing
        }

        enum UnresolvedReason: String, Codable {
            case notIndexedYet = "not_indexed_yet"
            case missing
            case tooCommon = "too_common"
        }

        struct FileDTO: Codable, Equatable {
            let path: String
            let role: String
            let depth: Int
            let reachedBy: [String]
            let content: String
            let tokens: Int

            private enum CodingKeys: String, CodingKey {
                case path, role, depth, content, tokens
                case reachedBy = "reached_by"
            }
        }

        struct IndexDTO: Codable, Equatable {
            let state: IndexState
            let indexed: UInt64
            let total: UInt64
        }

        struct SeedDTO: Codable, Equatable {
            let path: String
            let state: SeedState
        }

        struct NodeDTO: Codable, Equatable {
            let path: String
            let depth: Int
            let seed: Bool?
            let reachedBy: [String]

            private enum CodingKeys: String, CodingKey {
                case path, depth, seed
                case reachedBy = "reached_by"
            }
        }

        struct EdgeDTO: Codable, Equatable {
            let from: String
            let to: String
            let symbols: [String]
            let ambiguous: Bool?
        }

        struct UnresolvedDTO: Codable, Equatable {
            let from: String
            let name: String
            let reason: UnresolvedReason
        }

        struct TruncatedDTO: Codable, Equatable {
            let reason: String
            let droppedNodes: Int

            private enum CodingKeys: String, CodingKey {
                case reason
                case droppedNodes = "dropped_nodes"
            }
        }

        struct IssueDTO: Codable, Equatable {
            let code: String
            let phase: String
            let path: String?
            let retryable: Bool
            let retryAfterMilliseconds: Int?
            let attempted: Int?
            let limit: Int?
            let message: String

            private enum CodingKeys: String, CodingKey {
                case code, phase, path, retryable, attempted, limit, message
                case retryAfterMilliseconds = "retry_after_ms"
            }
        }

        struct RootDTO: Codable, Equatable {
            let root: String
            let status: Status
            let index: IndexDTO
            let updatesPending: Bool?
            let seeds: [SeedDTO]
            let nodes: [NodeDTO]
            let edges: [EdgeDTO]
            let unresolved: [UnresolvedDTO]
            let truncated: TruncatedDTO?
            let issues: [IssueDTO]

            private enum CodingKeys: String, CodingKey {
                case root, status, index, seeds, nodes, edges, unresolved, truncated, issues
                case updatesPending = "updates_pending"
            }
        }

        struct SummaryDTO: Codable, Equatable {
            let seeds: Int
            let nodes: Int
            let edges: Int
            let files: Int
            let tokens: Int
        }

        struct RetryDTO: Codable, Equatable {
            let retryable: Bool
            let retryAfterMilliseconds: Int?

            private enum CodingKeys: String, CodingKey {
                case retryable
                case retryAfterMilliseconds = "retry_after_ms"
            }
        }

        let status: Status
        let size: WorkspaceCodemapGraphOutputSize
        let roots: [RootDTO]
        let files: [FileDTO]
        let summary: SummaryDTO
        let issues: [IssueDTO]
        let retry: RetryDTO?
        let worktreeScope: WorktreeScopeDTO?

        init(
            status: Status,
            size: WorkspaceCodemapGraphOutputSize,
            roots: [RootDTO],
            files: [FileDTO],
            summary: SummaryDTO,
            issues: [IssueDTO],
            retry: RetryDTO?,
            worktreeScope: WorktreeScopeDTO?
        ) {
            self.status = status
            self.size = size
            self.roots = roots
            self.files = files
            self.summary = summary
            self.issues = issues
            self.retry = retry
            self.worktreeScope = worktreeScope
        }

        private enum CodingKeys: String, CodingKey {
            case status, size, roots, files, summary, issues, retry
            case worktreeScope = "worktree_scope"
        }
    }
}

// swiftlint:enable identifier_name nesting
