// Retained source layout and diagnostics; CCCC enforces configured complexity limits.
// swiftlint:disable function_body_length opening_brace statement_position
import Foundation

extension RPCESelectionCandidateResolver {
    func mutateSlices(
        base: StoredSelection,
        entries: [WorkspaceSelectionSliceInput],
        mode: SliceMutationMode,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceSliceSelectionMutationResult {
        let trimmedInputs = entries.map { $0.path.trimmingCharacters(in: .whitespacesAndNewlines) }
        var invalid: [String] = []
        var lookupInputs: [String] = []
        lookupInputs.reserveCapacity(trimmedInputs.count)
        for input in trimmedInputs where !input.isEmpty {
            if let issue = await store.exactPathResolutionIssue(for: input, kind: .file, rootScope: rootScope) {
                invalid.append(PathResolutionIssueRenderer.message(for: issue))
            } else {
                lookupInputs.append(input)
            }
        }
        let lookup = await store.lookupFiles(atPaths: lookupInputs, rootScope: rootScope)
        let roots = await store.rootRefs(scope: rootScope)
        func displayPath(for file: WorkspaceFileRecord) -> String {
            guard let root = roots.first(where: { $0.id == file.rootID }) else { return file.standardizedFullPath }
            return ClientPathFormatter.displayPath(
                root: root,
                relativePath: file.standardizedRelativePath,
                visibleRoots: roots
            )
        }

        var resolved: [String: String] = [:]
        let originalSlices = StoredSelectionPathNormalization.standardizedSlices(base.slices)
        let baseSelectedPaths = StoredSelectionPathNormalization.standardizedPaths(base.selectedPaths)
        var slices = originalSlices
        var selectedPaths = baseSelectedPaths
        var selectedSet = Set(selectedPaths)

        func resolveEntry(_ entry: WorkspaceSelectionSliceInput, at index: Int) -> WorkspaceFileRecord? {
            let input = trimmedInputs[index]
            guard !input.isEmpty else { return nil }
            guard !invalid.contains(where: { $0 == input || $0.contains(input) }) else { return nil }
            guard let file = lookup[input] else {
                invalid.append(entry.path)
                return nil
            }
            resolved[entry.path] = displayPath(for: file)
            return file
        }

        switch mode {
        case .set: slices = replacedSlices(entries, resolving: resolveEntry, base: [:])
        case .setPaths: slices = replacedSlices(entries, resolving: resolveEntry, base: slices)
        case .add: slices = addedSlices(entries, resolving: resolveEntry, base: slices)
        case .remove: slices = removedSlices(entries, resolving: resolveEntry, base: slices)
        }

        for (full, ranges) in slices where !ranges.isEmpty {
            if selectedSet.insert(full).inserted { selectedPaths.append(full) }
        }
        let nextSelection = StoredSelection(
            selectedPaths: selectedPaths,
            manualCodemapPaths: base.manualCodemapPaths.filter { !selectedSet.contains($0) },
            slices: slices,
            codemapAutoEnabled: base.codemapAutoEnabled
        )
        let mutated = nextSelection != base
        return WorkspaceSliceSelectionMutationResult(
            selection: nextSelection,
            invalidPaths: invalid,
            resolvedMap: resolved,
            mutated: mutated
        )
    }

    private func replacedSlices(_ entries: [WorkspaceSelectionSliceInput],
                                resolving resolve: (WorkspaceSelectionSliceInput, Int) -> WorkspaceFileRecord?,
                                base: [String: [LineRange]]) -> [String: [LineRange]]
    {
        var slices = base, aggregated: [String: [LineRange]] = [:]
        for (index, entry) in entries.enumerated() {
            guard let file = resolve(entry, index) else { continue }
            aggregated[file.standardizedFullPath, default: []].append(contentsOf: entry.ranges)
        }
        for (full, ranges) in aggregated {
            let normalized = SliceRangeMath.normalize(ranges)
            if normalized.isEmpty { slices.removeValue(forKey: full) } else { slices[full] = normalized }
        }
        return slices
    }

    private func addedSlices(_ entries: [WorkspaceSelectionSliceInput],
                             resolving resolve: (WorkspaceSelectionSliceInput, Int) -> WorkspaceFileRecord?,
                             base: [String: [LineRange]]) -> [String: [LineRange]]
    {
        var slices = base
        for (index, entry) in entries.enumerated() {
            guard let file = resolve(entry, index) else { continue }
            let normalized = SliceRangeMath.normalize(entry.ranges)
            guard !normalized.isEmpty else { continue }
            let next = SliceRangeMath.coalesce(slices[file.standardizedFullPath] ?? [], normalized)
            if next.isEmpty { slices.removeValue(forKey: file.standardizedFullPath) }
            else { slices[file.standardizedFullPath] = next }
        }
        return slices
    }

    private func removedSlices(_ entries: [WorkspaceSelectionSliceInput],
                               resolving resolve: (WorkspaceSelectionSliceInput, Int) -> WorkspaceFileRecord?,
                               base: [String: [LineRange]]) -> [String: [LineRange]]
    {
        var slices = base
        for (index, entry) in entries.enumerated() {
            guard let file = resolve(entry, index) else { continue }
            let full = file.standardizedFullPath, baseRanges = slices[full] ?? []
            if baseRanges.isEmpty && entry.ranges.isEmpty { slices.removeValue(forKey: full); continue }
            let removal = SliceRangeMath.normalize(entry.ranges)
            guard !baseRanges.isEmpty else { continue }
            let next = removal.isEmpty ? [] : SliceRangeMath.subtract(baseRanges, removing: removal)
            if next.isEmpty { slices.removeValue(forKey: full) } else { slices[full] = next }
        }
        return slices
    }
}

// swiftlint:enable function_body_length opening_brace statement_position
