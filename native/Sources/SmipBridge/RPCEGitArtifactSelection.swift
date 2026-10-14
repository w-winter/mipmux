// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

func selectionForPrimaryGitArtifactCommit(
    latestSelection: StoredSelection,
    contextSelection: StoredSelection
) -> StoredSelection {
    func appendUnique(
        _ paths: [String],
        to output: inout [String],
        identities: inout Set<String>
    ) {
        for path in paths {
            let identity = StoredSelectionPathNormalization.standardizedPath(path) ?? path
            guard !identity.isEmpty, identities.insert(identity).inserted else { continue }
            output.append(path)
        }
    }

    var selectedPaths: [String] = []
    var selectedIdentities = Set<String>()
    appendUnique(contextSelection.selectedPaths, to: &selectedPaths, identities: &selectedIdentities)
    appendUnique(latestSelection.selectedPaths, to: &selectedPaths, identities: &selectedIdentities)

    var manualCodemapPaths: [String] = []
    var manualCodemapIdentities = Set<String>()
    appendUnique(
        contextSelection.manualCodemapPaths,
        to: &manualCodemapPaths,
        identities: &manualCodemapIdentities
    )
    appendUnique(
        latestSelection.manualCodemapPaths,
        to: &manualCodemapPaths,
        identities: &manualCodemapIdentities
    )

    var slices = contextSelection.slices
    var sliceIdentities = Set(contextSelection.slices.keys.map {
        StoredSelectionPathNormalization.standardizedPath($0) ?? $0
    })
    for (path, ranges) in latestSelection.slices {
        let identity = StoredSelectionPathNormalization.standardizedPath(path) ?? path
        guard !identity.isEmpty, sliceIdentities.insert(identity).inserted else { continue }
        slices[path] = ranges
    }

    return StoredSelection(
        selectedPaths: selectedPaths,
        manualCodemapPaths: manualCodemapPaths,
        slices: slices,
        codemapAutoEnabled: contextSelection.codemapAutoEnabled && latestSelection.codemapAutoEnabled
    )
}
