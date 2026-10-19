// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: project captured file IDs using the accounting service's direct-file and slice-only rules.
import Foundation

struct ClipboardPresentationInput {
    struct Catalog: Decodable {
        let copyPreset: CapturedCopyPreset
        let roots: [ClipboardRoot]
        let files: [ClipboardFile]
        let readyFileIDs: [UUID]
    }

    let catalog: Catalog
    let selection: StoredSelection

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "copyPreset", "roots", "files", "selection", "readyFileIDs"])
        selection = try StoredSelection(wire: fields.value("selection"))
        do {
            catalog = try JSONDecoder().decode(Catalog.self, from: JSONSerialization.data(withJSONObject: value))
        } catch is DecodingError { throw BridgeFailure("nativeProtocolError") }
    }

    func render() async -> [String: Any] {
        let cfg = catalog.copyPreset.resolve()
        let plan = await WorkspaceCodemapPresentationIntentResolver.plan(codeMapUsage: cfg.codeMapUsage,
                                                                         selection: selection,
                                                                         store: WorkspaceFileContextStore(roots: catalog
                                                                             .roots, catalog: catalog.files.map {
                                                                                 WorkspaceFileRecord(
                                                                                     id: $0.id,
                                                                                     rootID: $0.rootID,
                                                                                     name: $0.name,
                                                                                     relativePath: $0
                                                                                         .standardizedRelativePath,
                                                                                     fullPath: $0.fullPath,
                                                                                     parentFolderID: nil,
                                                                                 )
                                                                             }), rootScope: .visibleWorkspace,
                                                                         profile: .uiAssisted)
        let ids: [UUID], kind: String, complete: Bool
        switch plan.intent {
        case .none: ids = []; kind = "none"; complete = false
        case let .automatic(values): ids = values; kind = "automatic"; complete = false
        case let .exact(values, completeRootSet): ids = values; kind = "exact"; complete = completeRootSet
        }
        // PromptContextAccountingService: direct selected paths may become maps; slice-only entries stay sliced.
        let selectedPaths = Set(selection.selectedPaths)
        let filesByPath = Dictionary(uniqueKeysWithValues: catalog.files.map { ($0.fullPath, $0.id) })
        let selectedFiles = Set(catalog.files.filter {
            selectedPaths.contains($0.fullPath) || selection.slices[$0.fullPath]?.isEmpty == false
        }.map(\.id))
        let maps: [UUID]
        if cfg.codeMapUsage == .selected {
            let ready = Set(catalog.readyFileIDs)
            maps = selection.selectedPaths.compactMap { path in
                guard let id = filesByPath[path], ready.contains(id) else { return nil }
                return id
            }
        } else {
            maps = catalog.readyFileIDs.filter {
                (cfg.codeMapUsage == .auto || cfg.codeMapUsage == .complete) && !selectedFiles.contains($0)
            }
        }
        return ["kind": "clipboardPresentation", "preset": catalog.copyPreset.wireResolved,
                "intent": kind, "fileIDs": ids.map { $0.uuidString.lowercased() }, "completeRootSet": complete,
                "codemapFileIDs": maps.map { $0.uuidString.lowercased() }]
    }
}
