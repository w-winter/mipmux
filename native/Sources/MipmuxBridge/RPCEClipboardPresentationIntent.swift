// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: bind a captured file catalog and extract the original lookup loop; source decisions are retained.
import Foundation
import RepoPromptCodeMapCore

struct ClipboardRoot: Decodable { let id: UUID; let standardizedFullPath: String }
struct ClipboardFile: Decodable {
    let id: UUID
    let rootID: UUID
    let name: String
    let standardizedRelativePath: String
    let fullPath: String
}

struct WorkspaceFileContextStore {
    let roots: [ClipboardRoot]
    let catalog: [WorkspaceFileRecord]
    func rootRefs(scope _: WorkspaceLookupRootScope) async -> [ClipboardRoot] {
        roots
    }

    func files(inRoot id: UUID) async -> [WorkspaceFileRecord] {
        catalog.filter { $0.rootID == id }
    }

    func lookupPath(_ path: String, profile _: PathLocateProfile,
                    rootScope _: WorkspaceLookupRootScope) async -> WorkspacePathLookupResult? {
        catalog.first { $0.fullPath == path }.map { file in
            WorkspacePathLookupResult(input: path, location: WorkspacePathLocation(
                rootID: file.rootID,
                rootPath: roots.first { $0.id == file.rootID }!.standardizedFullPath,
                correctedPath: path,
            ), file: file, folder: nil)
        }
    }

    func lookupPaths(_ requests: [WorkspacePathLookupRequest]) async -> [String: WorkspacePathLookupResult] {
        var results: [String: WorkspacePathLookupResult] = [:]
        for request in requests {
            results[request.userPath] = await lookupPath(
                request.userPath,
                profile: request.profile,
                rootScope: request.rootScope,
            )
        }
        return results
    }
}

enum SyntaxManager {
    static func supportsCodeMap(fileExtension: String) -> Bool {
        CodeMapSyntaxEngine
            .supportsCodeMap(fileExtension: fileExtension)
    }
}

// Retained source type names and layout; decision complexity remains checked by CCCC.
// swiftlint:disable type_name
enum WorkspaceCodemapOperationPresentationIntent {
    case none
    case automatic(sourceFileIDs: [UUID])
    case exact(fileIDs: [UUID], completeRootSet: Bool)
}

enum WorkspaceCodemapOperationIssue {}
struct WorkspaceCodemapOperationPresentationPlan {
    let intent: WorkspaceCodemapOperationPresentationIntent
    let preflightIssues: [WorkspaceCodemapOperationIssue]
}
// swiftlint:disable function_body_length cyclomatic_complexity opening_brace
enum WorkspaceCodemapPresentationIntentResolver {
    static func plan(
        codeMapUsage: CodeMapUsage,
        selection: StoredSelection,
        store: WorkspaceFileContextStore,
        rootScope: WorkspaceLookupRootScope,
        profile: PathLocateProfile
    ) async -> WorkspaceCodemapOperationPresentationPlan {
        guard codeMapUsage != .none else {
            return WorkspaceCodemapOperationPresentationPlan(intent: .none, preflightIssues: [])
        }

        let roots = await store.rootRefs(scope: rootScope)
        let rootsByID = Dictionary(uniqueKeysWithValues: roots.map { ($0.id, $0) })
        let sourcePaths: [String] = switch codeMapUsage {
        case .auto where !selection.codemapAutoEnabled:
            selection.manualCodemapPaths
        case .selected:
            selection.selectedPaths + selection.manualCodemapPaths
        case .auto, .complete, .none:
            selection.selectedPaths
        }
        let selectedRequests = sourcePaths.map {
            WorkspacePathLookupRequest(userPath: $0, profile: profile, rootScope: rootScope)
        }
        let selectedResults = await store.lookupPaths(selectedRequests)
        var sourceFilesByID = await resolveSourceFiles(sourcePaths: sourcePaths, selectedResults: selectedResults,
            store: store, rootScope: rootScope, profile: profile)
        if codeMapUsage != .auto || selection.codemapAutoEnabled {
            for path in selection.slices.keys.sorted(by: utf8Precedes) {
                if let file = await store.lookupPath(path, profile: profile, rootScope: rootScope)?.file {
                    sourceFilesByID[file.id] = file
                }
            }
        }

        let requestedFiles: [WorkspaceFileRecord]
        let completeRootSet: Bool
        if codeMapUsage == .complete {
            completeRootSet = true
            var completeFiles: [WorkspaceFileRecord] = []
            for root in roots {
                await completeFiles.append(contentsOf: store.files(inRoot: root.id).filter { file in
                    let fileExtension = (file.name as NSString).pathExtension.lowercased()
                    return !fileExtension.isEmpty
                        && SyntaxManager.supportsCodeMap(fileExtension: fileExtension)
                })
            }
            requestedFiles = completeFiles
        } else {
            completeRootSet = false
            requestedFiles = Array(sourceFilesByID.values)
        }

        let orderedFiles = requestedFiles.sorted { lhs, rhs in
            let lhsRoot = rootsByID[lhs.rootID]?.standardizedFullPath ?? ""
            let rhsRoot = rootsByID[rhs.rootID]?.standardizedFullPath ?? ""
            if lhsRoot != rhsRoot { return lhsRoot.utf8.lexicographicallyPrecedes(rhsRoot.utf8) }
            if lhs.standardizedRelativePath != rhs.standardizedRelativePath {
                return lhs.standardizedRelativePath.utf8.lexicographicallyPrecedes(
                    rhs.standardizedRelativePath.utf8
                )
            }
            return lhs.id.uuidString < rhs.id.uuidString
        }
        let fileIDs = orderedFiles.map(\.id)
        let intent: WorkspaceCodemapOperationPresentationIntent = if codeMapUsage == .auto,
                                                                     selection.codemapAutoEnabled
        {
            .automatic(sourceFileIDs: fileIDs)
        } else {
            .exact(fileIDs: fileIDs, completeRootSet: completeRootSet)
        }
        return WorkspaceCodemapOperationPresentationPlan(intent: intent, preflightIssues: [])
    }
    private static func resolveSourceFiles(
        sourcePaths: [String], selectedResults: [String: WorkspacePathLookupResult], store: WorkspaceFileContextStore,
        rootScope: WorkspaceLookupRootScope, profile: PathLocateProfile
    ) async -> [UUID: WorkspaceFileRecord] {
        var sourceFilesByID: [UUID: WorkspaceFileRecord] = [:]
        for path in sourcePaths {
            let result: WorkspacePathLookupResult? = if let batched = selectedResults[path] {
                batched
            } else {
                await store.lookupPath(path, profile: profile, rootScope: rootScope)
            }
            guard let result else { continue }
            if let file = result.file {
                sourceFilesByID[file.id] = file
            } else if let folder = result.folder {
                let prefix = folder.standardizedRelativePath
                for file in await store.files(inRoot: folder.rootID)
                    where prefix.isEmpty
                    || file.standardizedRelativePath == prefix
                    || file.standardizedRelativePath.hasPrefix(prefix + "/")
                {
                    sourceFilesByID[file.id] = file
                }
            }
        }
        return sourceFilesByID
    }
    private static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
    }
}
// swiftlint:enable function_body_length cyclomatic_complexity opening_brace type_name
