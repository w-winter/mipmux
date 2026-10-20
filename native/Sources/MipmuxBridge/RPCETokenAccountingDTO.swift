// RPCE token-accounting DTO names and Codable keys.
// swiftlint:disable nesting
import Foundation

extension ToolResultDTOs {
    struct CopyPresetProjectionSummaryDTO: Codable, Equatable {
        let codeMapUsage: String
        let includesFiles: Bool
        let totalTokens: Int

        private enum CodingKeys: String, CodingKey {
            case codeMapUsage = "codemap_usage"
            case includesFiles = "includes_files"
            case totalTokens = "total_tokens"
        }
    }

    // MARK: - Unified prompt + selection + context (codemaps-first)

    struct TokenAccountingDTO: Codable, Equatable {
        let status: String
        let source: String
        let refreshPending: Bool
        let incompleteComponents: [String]?

        init(
            status: String,
            source: String,
            refreshPending: Bool,
            incompleteComponents: [String]? = nil
        ) {
            self.status = status
            self.source = source
            self.refreshPending = refreshPending
            self.incompleteComponents = incompleteComponents
        }

        private enum CodingKeys: String, CodingKey {
            case status
            case source
            case refreshPending = "refresh_pending"
            case incompleteComponents = "incomplete_components"
        }
    }

    struct TokenStats: Codable, Equatable {
        let total: Int
        let files: Int
        let prompt: Int?
        let fileTree: Int?
        let meta: Int?
        let git: Int?
        let other: Int?
        /// Token count from full files and slices (excludes codemaps)
        let filesContent: Int?
        /// Token count from codemaps only
        let codemaps: Int?

        init(
            total: Int,
            files: Int,
            prompt: Int? = nil,
            fileTree: Int? = nil,
            meta: Int? = nil,
            git: Int? = nil,
            other: Int? = nil,
            filesContent: Int? = nil,
            codemaps: Int? = nil
        ) {
            self.total = total
            self.files = files
            self.prompt = prompt
            self.fileTree = fileTree
            self.meta = meta
            self.git = git
            self.other = other
            self.filesContent = filesContent
            self.codemaps = codemaps
        }

        private enum CodingKeys: String, CodingKey {
            case total
            case files
            case prompt
            case fileTree = "file_tree"
            case meta
            case git
            case other
            case filesContent = "files_content"
            case codemaps
        }
    }
}

// swiftlint:enable nesting
