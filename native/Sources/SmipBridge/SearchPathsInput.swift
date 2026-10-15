import Foundation
import RepoPromptRegexCore

struct SearchPathFile {
    let ordinal: Int
    let alias: String
    let relativePath: String
    let standardizedRelativePath: String
    let standardizedRootFolderPath: String
    let standardizedFullPath: String

    var fileExtension: String? {
        let ext = ((relativePath as NSString).lastPathComponent as NSString).pathExtension
        return ext.isEmpty ? nil : ext
    }

    init(_ value: Any, ordinal: Int) throws {
        let input = try WireObject(value, keys: ["root", "path", "rootPath"])
        self.ordinal = ordinal
        alias = try input.string("root")
        relativePath = try input.string("path")
        standardizedRelativePath = StandardizedPath.relative(relativePath)
        standardizedRootFolderPath = try StandardizedPath.absolute(input.string("rootPath"))
        standardizedFullPath = StandardizedPath.join(
            standardizedRoot: standardizedRootFolderPath, standardizedRelativePath: standardizedRelativePath
        )
    }
}

struct SearchFilterOptions {
    let includeExtensions: [String]
    let excludePatterns: [String]

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: ["extensions", "exclude"])
        guard let extensions = try input.value("extensions") as? [String],
              let exclude = try input.value("exclude") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        includeExtensions = extensions
        excludePatterns = exclude
    }
}

struct SearchPathsInput {
    private let files: [SearchPathFile]
    private let inputCount: Int
    private let mode: SearchMode
    private let pattern: String
    private let isRegex: Bool
    private let caseInsensitive: Bool
    private let limit: Int

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: [
            "kind", "files", "mode", "pattern", "isRegex", "caseSensitive", "limit", "filters"
        ])
        guard let files = try input.value("files") as? [Any],
              let mode = try SearchMode(rawValue: input.string("mode")), mode != .auto
        else { throw BridgeFailure("nativeProtocolError") }
        let descriptors = try files.enumerated().map { try SearchPathFile($0.element, ordinal: $0.offset) }
        self.files = try RPCESearchPaths.filterFiles(descriptors, options: SearchFilterOptions(input.value("filters")))
        inputCount = descriptors.count
        self.mode = mode
        pattern = try input.text("pattern")
        isRegex = try input.boolean("isRegex")
        caseInsensitive = try !input.boolean("caseSensitive")
        limit = try input.integer("limit")
    }

    func render() throws -> [String: Any] {
        let order = files.indices.sorted {
            let left = files[$0].standardizedFullPath
            let right = files[$1].standardizedFullPath
            return mode == .path ? WorkspaceCodemapGraphOrdering.utf8Precedes(left, right) : left < right
        }
        do {
            let matches = try matchingIndices(order: order)
            let included = Set(files.map(\.ordinal))
            let excluded = (0 ..< inputCount).filter { !included.contains($0) }
            return ["kind": "searchPaths", "order": order.map { files[$0].ordinal },
                    "matches": matches.map { files[$0].ordinal }, "excluded": excluded]
        } catch let error as PCRE2Error {
            return ["kind": "searchPathsError", "message":
                RepoPromptPCRE2Adapter.searchPatternError(from: error, pattern: pattern).localizedDescription]
        } catch let error as RegexPatternFailure {
            return ["kind": "searchPathsError", "message": error.localizedDescription]
        }
    }

    private func matchingIndices(order: [Int]) throws -> [Int] {
        guard mode != .content, !pattern.isEmpty, !files.isEmpty, limit > 0 else { return [] }
        let hasWildcards = pattern.contains("*") || pattern.contains("?")
        let useRegex = isRegex && !(hasWildcards && !RPCESearchPattern.containsRegexSyntax(pattern))
        let suffix = useRegex ? RepoPromptPCRE2Adapter.pathSuffixPattern(forRegex: pattern) : nil
        let regex = try useRegex && suffix == nil ? RepoPromptPCRE2Adapter.compile(RepoPromptPCRE2CompileRequest(
            pattern: pattern, caseInsensitive: caseInsensitive, multilineAnchors: false
        )) : nil
        let aliases = files.reduce(into: [String: String]()) { $0[$1.standardizedRootFolderPath] = $1.alias }
        let plan = SearchPathScanPlan(trimmedPattern: pattern, regex: regex, pathSuffixPattern: suffix,
                                      caseInsensitive: caseInsensitive, isRegex: useRegex, aliasByRootPath: aliases)
        let indices = mode == .path ? order : files.indices.sorted {
            WorkspaceCodemapGraphOrdering.utf8Precedes(files[$0].standardizedFullPath, files[$1].standardizedFullPath)
        }
        var matches: [Int] = []
        for index in indices {
            try Task.checkCancellation()
            if try RPCESearchPaths.scanPath(files[index], plan: plan) {
                matches.append(index)
                if matches.count >= limit { break }
            }
        }
        return matches
    }
}
