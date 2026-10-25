// Retained source branches and result contracts; CCCC enforces configured complexity limits.
// swiftlint:disable function_body_length large_tuple
import Foundation

extension RPCESelectionCandidateResolver {
    func addPaths(
        existing: StoredSelection,
        paths: [String],
        rawPaths: [String],
        mode: String,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceAddSelectionResult {
        if mode == "codemap_only" {
            let resolution = await resolveCodemapOnlyCandidates(
                paths: paths,
                rawPaths: rawPaths,
                expandFolders: true,
                rootScope: rootScope
            )
            guard !resolution.candidates.isEmpty else {
                return WorkspaceAddSelectionResult(
                    selection: existing,
                    invalidPaths: resolution.invalidPaths,
                    resolvedMap: resolution.resolvedMap,
                    mutated: false,
                    codemapUnavailable: resolution.codemapUnavailable
                )
            }
            var selectedPaths = StoredSelectionPathNormalization.standardizedPaths(existing.selectedPaths)
            var slices = StoredSelectionPathNormalization.standardizedSlices(existing.slices)
            var manualPaths = StoredSelectionPathNormalization.standardizedPaths(existing.manualCodemapPaths)
            var manualSet = Set(manualPaths)
            for file in resolution.candidates {
                let path = file.standardizedFullPath
                selectedPaths.removeAll { $0 == path }
                slices.removeValue(forKey: path)
                if manualSet.insert(path).inserted { manualPaths.append(path) }
            }
            // Unlike RPCE, choosing codemaps keeps automatic codemaps on; only clearing codemaps turns them off.
            let selection = StoredSelection(
                selectedPaths: selectedPaths,
                manualCodemapPaths: manualPaths,
                slices: slices,
                codemapAutoEnabled: existing.codemapAutoEnabled
            )
            return WorkspaceAddSelectionResult(
                selection: selection,
                invalidPaths: resolution.invalidPaths,
                resolvedMap: resolution.resolvedMap,
                mutated: selection != existing,
                codemapUnavailable: resolution.codemapUnavailable
            )
        }
        let resolution = await resolveSelectionCandidates(
            paths: paths,
            rawPaths: rawPaths,
            expandFolders: true,
            rootScope: rootScope
        )

        var selectedPaths = existing.selectedPaths
        let slices = existing.slices
        var selectedSet = Set(selectedPaths)
        for file in resolution.candidates where selectedSet.insert(file.standardizedFullPath).inserted {
            selectedPaths.append(file.standardizedFullPath)
        }
        let selection = StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: existing.manualCodemapPaths.filter { !selectedSet.contains($0) },
            slices: slices,
            codemapAutoEnabled: existing.codemapAutoEnabled
        )
        return WorkspaceAddSelectionResult(
            selection: selection,
            invalidPaths: resolution.invalidPaths,
            resolvedMap: resolution.resolvedMap,
            mutated: selection != existing,
            codemapUnavailable: []
        )
    }

    func removePaths(
        existing: StoredSelection,
        paths: [String],
        rawPaths: [String],
        mode: String = "full",
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceRemoveSelectionResult {
        if mode == "codemap_only" {
            let resolution = await resolveSelectionCandidates(
                paths: paths,
                rawPaths: rawPaths,
                expandFolders: true,
                allowEmptyFolderExpansion: true,
                rootScope: rootScope
            )
            let removedPaths = Set(resolution.candidates.map(\.standardizedFullPath))
            let selection = StoredSelection(
                selectedPaths: existing.selectedPaths,
                manualCodemapPaths: existing.manualCodemapPaths.filter { !removedPaths.contains($0) },
                slices: existing.slices,
                codemapAutoEnabled: existing.codemapAutoEnabled
            )
            return WorkspaceRemoveSelectionResult(
                selection: selection,
                invalidPaths: resolution.invalidPaths,
                resolvedMap: resolution.resolvedMap,
                mutated: selection != existing
            )
        }
        let resolution = await resolveSelectionCandidates(
            paths: paths,
            rawPaths: rawPaths,
            expandFolders: true,
            allowEmptyFolderExpansion: true,
            rootScope: rootScope
        )
        var selectedPaths = existing.selectedPaths
        var slices = existing.slices
        for file in resolution.candidates {
            selectedPaths.removeAll { $0 == file.standardizedFullPath }
            _ = removeSliceEntries(for: file, in: &slices)
        }
        let selection = StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: existing.manualCodemapPaths,
            slices: slices,
            codemapAutoEnabled: existing.codemapAutoEnabled
        )
        return WorkspaceRemoveSelectionResult(
            selection: selection,
            invalidPaths: resolution.invalidPaths,
            resolvedMap: resolution.resolvedMap,
            mutated: selection != existing
        )
    }

    func promotePaths(
        existing: StoredSelection,
        paths: [String],
        rawPaths: [String],
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> (selection: StoredSelection, invalidPaths: [String], mutated: Bool, validCandidateCount: Int) {
        let resolution = await resolveSelectionCandidates(
            paths: paths,
            rawPaths: rawPaths,
            expandFolders: false,
            rootScope: rootScope
        )
        var selectedPaths = existing.selectedPaths
        var manualCodemapPaths = existing.manualCodemapPaths
        var slices = existing.slices
        var selectedSet = Set(selectedPaths)
        var mutated = false

        for file in resolution.candidates {
            let path = file.standardizedFullPath
            if !selectedSet.contains(path) {
                selectedPaths.append(path)
                selectedSet.insert(path)
                mutated = true
            }
            manualCodemapPaths.removeAll { $0 == path }
            if removeSliceEntries(for: file, in: &slices) { mutated = true }
        }

        let selection = StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: manualCodemapPaths,
            slices: slices,
            codemapAutoEnabled: existing.codemapAutoEnabled
        )
        return (
            selection,
            resolution.invalidPaths,
            selection != existing || mutated,
            resolution.candidates.count
        )
    }

    func demotePaths(
        existing: StoredSelection,
        paths: [String],
        rawPaths: [String],
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceDemoteSelectionResult {
        let resolution = await resolveCodemapOnlyCandidates(
            paths: paths,
            rawPaths: rawPaths,
            expandFolders: false,
            rootScope: rootScope
        )
        guard !resolution.candidates.isEmpty else {
            return WorkspaceDemoteSelectionResult(
                selection: existing,
                invalidPaths: resolution.invalidPaths,
                codemapUnavailable: resolution.codemapUnavailable,
                mutated: false,
                validCandidateCount: resolution.candidates.count
            )
        }
        var selectedPaths = existing.selectedPaths
        var slices = existing.slices
        var manualCodemapPaths = existing.manualCodemapPaths
        var manualSet = Set(manualCodemapPaths)
        for file in resolution.candidates {
            let path = file.standardizedFullPath
            selectedPaths.removeAll { $0 == path }
            _ = removeSliceEntries(for: file, in: &slices)
            if manualSet.insert(path).inserted { manualCodemapPaths.append(path) }
        }
        // Unlike RPCE, demotion keeps automatic codemaps on for the files the remaining selection references.
        let selection = StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: manualCodemapPaths,
            slices: slices,
            codemapAutoEnabled: existing.codemapAutoEnabled
        )
        return WorkspaceDemoteSelectionResult(
            selection: selection,
            invalidPaths: resolution.invalidPaths,
            codemapUnavailable: resolution.codemapUnavailable,
            mutated: selection != existing,
            validCandidateCount: resolution.candidates.count
        )
    }

    private func removeSliceEntries(for file: WorkspaceFileRecord, in slices: inout [String: [LineRange]]) -> Bool {
        slices.removeValue(forKey: file.standardizedFullPath) != nil
    }
}

// swiftlint:enable function_body_length large_tuple
