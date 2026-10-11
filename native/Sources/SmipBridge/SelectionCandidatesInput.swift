import Foundation

struct SelectionCandidatesInput {
    private let paths: [String]
    private let rawPaths: [String]
    private let expandFolders: Bool
    private let allowEmptyFolderExpansion: Bool
    private let mode: String
    private let catalog: SelectionCatalog

    init(_ value: Any) throws {
        let input = try WireObject(
            value,
            keys: [
                "kind",
                "paths",
                "rawPaths",
                "expandFolders",
                "allowEmptyFolderExpansion",
                "mode",
                "roots",
                "materialization"
            ]
        )
        guard let paths = input.fields["paths"] as? [String], let rawPaths = input.fields["rawPaths"] as? [String],
              let roots = input.fields["roots"] as? [Any], let outcomes = input.fields["materialization"] as? [Any]
        else { throw BridgeFailure("nativeProtocolError") }
        self.paths = paths
        self.rawPaths = rawPaths
        expandFolders = try input.boolean("expandFolders")
        allowEmptyFolderExpansion = try input.boolean("allowEmptyFolderExpansion")
        mode = try input.string("mode")
        guard mode == "full" || mode == "codemapOnly" else { throw BridgeFailure("nativeProtocolError") }
        catalog = try SelectionCatalog(wireRoots: roots, outcomes: outcomes, paths: paths)
    }

    func render() async -> [String: Any] {
        let service = RPCESelectionCandidateResolver(store: catalog)
        if mode == "codemapOnly" {
            let result = await service.resolveCodemapOnlyCandidates(
                paths: paths,
                rawPaths: rawPaths,
                expandFolders: expandFolders
            )
            return render(result.candidates, result.resolvedMap, result.invalidPaths, result.codemapUnavailable)
        }
        let result = await service.resolveSelectionCandidates(
            paths: paths,
            rawPaths: rawPaths,
            expandFolders: expandFolders,
            allowEmptyFolderExpansion: allowEmptyFolderExpansion
        )
        return render(result.candidates, result.resolvedMap, result.invalidPaths, [])
    }

    private func render(_ candidates: [WorkspaceFileRecord], _ resolvedMap: [String: String],
                        _ invalidPaths: [String], _ codemapUnavailable: [String]) -> [String: Any] {
        [
            "kind": "selectionCandidates",
            "candidates": candidates.map { [
                "rootId": $0.rootID.uuidString.lowercased(),
                "path": $0.standardizedRelativePath
            ] },
            "resolvedMap": resolvedMap,
            "invalidPaths": invalidPaths,
            "codemapUnavailable": codemapUnavailable
        ]
    }
}
