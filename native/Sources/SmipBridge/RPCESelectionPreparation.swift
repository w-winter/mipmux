// Retained source layout and diagnostics; CCCC enforces configured complexity limits.
// swiftlint:disable function_body_length line_length opening_brace
import Foundation

extension RPCESelectionCandidateResolver {
    func buildSelection(
        paths: [String],
        slices sliceInputs: [WorkspaceSelectionSliceInput] = [],
        sliceErrors: [String] = [],
        mode: String,
        existing: StoredSelection,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceBuildSelectionResult {
        if mode == "codemap_only" {
            let resolution = await resolveCodemapOnlyCandidates(
                paths: paths,
                rawPaths: paths,
                expandFolders: true,
                rootScope: rootScope
            )
            return WorkspaceBuildSelectionResult(
                selection: StoredSelection(
                    manualCodemapPaths: resolution.candidates.map(\.standardizedFullPath),
                    codemapAutoEnabled: false
                ),
                invalidPaths: sliceErrors + resolution.invalidPaths,
                codemapUnavailable: resolution.codemapUnavailable
            )
        }

        var invalid = sliceErrors
        let codemapUnavailable: [String] = []
        var selectedPaths: [String] = []
        var seenSelected = Set<String>()
        var slicesByPath: [String: [LineRange]] = [:]

        let resolution = await resolveSelectionCandidates(
            paths: paths,
            rawPaths: paths,
            expandFolders: true,
            rootScope: rootScope
        )
        invalid.append(contentsOf: resolution.invalidPaths)
        for file in resolution.candidates where seenSelected.insert(file.standardizedFullPath).inserted {
            selectedPaths.append(file.standardizedFullPath)
        }

        let slicePaths = sliceInputs.map(\.path)
        let resolvedSlices = await store.lookupFiles(atPaths: slicePaths, rootScope: rootScope)
        for entry in sliceInputs {
            let trimmed = entry.path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            guard let file = resolvedSlices[trimmed] else {
                invalid.append(trimmed)
                continue
            }
            let fullPath = file.standardizedFullPath
            if seenSelected.insert(fullPath).inserted {
                selectedPaths.append(fullPath)
            }
            if !entry.ranges.isEmpty {
                slicesByPath[fullPath, default: []].append(contentsOf: entry.ranges)
            }
        }
        slicesByPath = normalizeSlices(slicesByPath)

        let selection = StoredSelection(
            selectedPaths: selectedPaths,
            slices: slicesByPath,
            codemapAutoEnabled: existing.codemapAutoEnabled
        )
        return WorkspaceBuildSelectionResult(
            selection: selection,
            invalidPaths: invalid,
            codemapUnavailable: codemapUnavailable
        )
    }

    func buildManageSelectionSet(
        paths: [String],
        slices sliceInputs: [WorkspaceSelectionSliceInput] = [],
        sliceErrors: [String] = [],
        mode: String,
        existing: StoredSelection,
        hasFullFileArtifactInputs: Bool = false,
        rootScope: WorkspaceLookupRootScope = .visibleWorkspace
    ) async -> WorkspaceBuildSelectionResult {
        if mode == "codemap_only", !sliceInputs.isEmpty {
            return WorkspaceBuildSelectionResult(
                selection: existing,
                invalidPaths: sliceErrors + ["mode 'codemap_only' cannot be used with slices"],
                codemapUnavailable: []
            )
        }

        if mode == "slices" {
            let validSliceInputs = sliceInputs.filter { !SliceRangeMath.normalize($0.ranges).isEmpty }
            let pathsWithRanges = Set(validSliceInputs.map { $0.path.trimmingCharacters(in: .whitespacesAndNewlines) })
            var pathsMissingRanges: [String] = []
            var seenMissing = Set<String>()
            for path in paths.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
                where !path.isEmpty && !pathsWithRanges.contains(path)
            {
                if seenMissing.insert(path).inserted { pathsMissingRanges.append(path) }
            }
            for entry in sliceInputs where SliceRangeMath.normalize(entry.ranges).isEmpty {
                let path = entry.path.trimmingCharacters(in: .whitespacesAndNewlines)
                if !path.isEmpty, seenMissing.insert(path).inserted { pathsMissingRanges.append(path) }
            }
            if !pathsMissingRanges.isEmpty {
                return WorkspaceBuildSelectionResult(
                    selection: existing,
                    invalidPaths: sliceErrors +
                        [
                            "mode 'slices' requires line ranges for paths: \(pathsMissingRanges.joined(separator: ", ")). Use #L ranges, the slices array, or op='add' mode='full' for whole files."
                        ],
                    codemapUnavailable: []
                )
            }
            if validSliceInputs.isEmpty {
                let invalid = sliceErrors.isEmpty
                    ? ["mode 'slices' requires a non-empty slices array or #L line ranges on paths."]
                    : sliceErrors
                return WorkspaceBuildSelectionResult(
                    selection: existing,
                    invalidPaths: invalid,
                    codemapUnavailable: []
                )
            }
        }

        let isSliceScopedSet = mode == "slices" || (!hasFullFileArtifactInputs && paths.isEmpty && !sliceInputs.isEmpty)
        guard isSliceScopedSet else {
            let replacementSeed = StoredSelection(
                codemapAutoEnabled: existing.codemapAutoEnabled
            )
            return await buildSelection(
                paths: paths,
                slices: sliceInputs,
                sliceErrors: sliceErrors,
                mode: mode,
                existing: replacementSeed,
                rootScope: rootScope
            )
        }

        let sliceResult = await mutateSlices(
            base: existing,
            entries: sliceInputs,
            mode: .setPaths,
            rootScope: rootScope
        )
        return WorkspaceBuildSelectionResult(
            selection: sliceResult.selection,
            invalidPaths: sliceErrors + sliceResult.invalidPaths,
            codemapUnavailable: []
        )
    }

    private func normalizeSlices(_ slices: [String: [LineRange]]) -> [String: [LineRange]] {
        var normalized: [String: [LineRange]] = [:]
        for (path, ranges) in slices {
            let value = SliceRangeMath.normalize(ranges)
            if !value.isEmpty { normalized[path] = value }
        }
        return normalized
    }
}

// swiftlint:enable function_body_length line_length opening_brace
