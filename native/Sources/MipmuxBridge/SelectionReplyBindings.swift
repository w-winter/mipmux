import Foundation

extension RPCESelectionReplyAssembler {
    struct CapturedFile {
        let id: UUID
        let displayPath: String
        let rootPath: String
        let pathWithinRoot: String
    }

    struct CapturedEntry {
        let file: CapturedFile
        let tokens: Int
        let lineRanges: [LineRange]?
    }

    struct SelectedEntry {
        let entry: CapturedEntry
        var ranges: [LineRange]? {
            entry.lineRanges
        }

        var file: CapturedFile {
            entry.file
        }
    }

    enum CodemapOrigin: String {
        case auto
        case manual
        case selectedMode = "selected_mode"
    }

    struct CodemapEntry {
        let entry: CapturedEntry
        let origin: CodemapOrigin
        var file: CapturedFile {
            entry.file
        }
    }

    struct CodemapPresentation {
        let tokensByFileID: [UUID: Int]
    }

    struct SelectionCollections {
        let selected: [SelectedEntry]
        let codemap: [CodemapEntry]
        let codeMapUsage: CodeMapUsage
        let codemapPresentation: CodemapPresentation
    }

    struct PathFormatter {
        func displayPath(for file: CapturedFile) async -> String {
            file.displayPath
        }
    }

    struct TokenServices {
        func fullTokens(for entry: CapturedEntry) -> Int {
            entry.tokens
        }

        func sliceTokens(for entry: CapturedEntry, ranges _: [LineRange]) async -> Int {
            entry.tokens
        }

        func codemapTokens(for file: CapturedFile, codemapPresentation: CodemapPresentation) -> Int {
            codemapPresentation.tokensByFileID[file.id] ?? 0
        }
    }

    struct CopyPresetProjectionConfig {
        let includeFiles: Bool
        let codeMapUsage: CodeMapUsage
    }

    struct CapturedEntryResult {
        let displayTokens: Int
    }

    static func pathMetadata(
        for file: CapturedFile,
        entry _: CapturedEntry? = nil,
        formatter _: PathFormatter
    ) async -> (rootPath: String, pathWithinRoot: String) {
        (file.rootPath, file.pathWithinRoot)
    }
}
