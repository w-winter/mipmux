import Foundation

/// RPCE WorkspaceSelectionMutationService.swift:385-460; identities are already authorized by the caller.
struct RPCESelectionTransitions {
    func mutatePreResolvedFullFilePaths(
        base: StoredSelection,
        absolutePaths: [String],
        mode: WorkspacePreResolvedFullFileMutationMode
    ) -> StoredSelection {
        var selected = StoredSelectionPathNormalization.standardizedPaths(base.selectedPaths)
        var slices = StoredSelectionPathNormalization.standardizedSlices(base.slices)
        var selectedSet = Set(selected)

        let identities = absolutePaths.compactMap(StoredSelectionPathNormalization.standardizedPath)
        for identity in identities {
            switch mode {
            case .add:
                if selectedSet.insert(identity).inserted {
                    selected.append(identity)
                }
                slices.removeValue(forKey: identity)
            case .remove:
                selected.removeAll { $0 == identity }
                selectedSet.remove(identity)
                slices.removeValue(forKey: identity)
            }
        }

        return StoredSelection(
            selectedPaths: selected,
            manualCodemapPaths: base.manualCodemapPaths.filter { !selectedSet.contains($0) },
            slices: slices,
            codemapAutoEnabled: base.codemapAutoEnabled
        )
    }

    /// Sets store-revalidated files to one exclusive selection representation for Context Composer browse toggles.
    /// MCP Git artifact mutations use `mutatePreResolvedFullFilePaths` because they have different representation
    /// semantics.
    func setPreResolvedFilePaths(
        base: StoredSelection,
        absolutePaths: [String],
        targetState: WorkspacePreResolvedSelectionTargetState
    ) -> StoredSelection {
        let identities = StoredSelectionPathNormalization.standardizedPaths(absolutePaths)
        guard !identities.isEmpty else { return base }

        let identitySet = Set(identities)
        var selectedPaths = StoredSelectionPathNormalization.standardizedPaths(base.selectedPaths)
        var manualCodemapPaths = StoredSelectionPathNormalization.standardizedPaths(base.manualCodemapPaths)
        var slices = StoredSelectionPathNormalization.standardizedSlices(base.slices)

        switch targetState {
        case .full:
            var selectedSet = Set(selectedPaths)
            for identity in identities where selectedSet.insert(identity).inserted {
                selectedPaths.append(identity)
            }
            manualCodemapPaths.removeAll { identitySet.contains($0) }
            slices = slices.filter { !identitySet.contains($0.key) }
        case .codemapOnly:
            selectedPaths.removeAll { identitySet.contains($0) }
            slices = slices.filter { !identitySet.contains($0.key) }
            var manualCodemapSet = Set(manualCodemapPaths)
            for identity in identities where manualCodemapSet.insert(identity).inserted {
                manualCodemapPaths.append(identity)
            }
        case .unselected:
            selectedPaths.removeAll { identitySet.contains($0) }
            manualCodemapPaths.removeAll { identitySet.contains($0) }
            slices = slices.filter { !identitySet.contains($0.key) }
        }

        return StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: manualCodemapPaths,
            slices: slices,
            codemapAutoEnabled: base.codemapAutoEnabled
        )
    }
}
