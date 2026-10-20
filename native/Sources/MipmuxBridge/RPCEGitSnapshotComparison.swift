// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct RPCEGitSnapshotComparison {
    struct Failure: Error {
        let code: String
        let message: String
    }

    func resolveCompareSpec(
        _ compareRaw: String, displayName: String,
        currentID: () throws -> String?, manifest: (String) throws -> GitDiffSnapshotManifest?
        // swiftlint:disable:next large_tuple
    ) throws -> (spec: GitDiffCompareSpec, resolved: String, input: String?) {
        let trimmed = compareRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawInput = trimmed.isEmpty ? "uncommitted" : trimmed
        let lowered = rawInput.lowercased()

        if lowered == "last" {
            guard let currentID = try currentID() else {
                throw Failure(code: "gitSnapshotUnavailable",
                              message: "No CURRENT snapshot available for compare: \"last\" in repo: \(displayName)")
            }
            guard let manifest = try? manifest(currentID) else {
                throw Failure(code: "gitSnapshotManifestUnavailable",
                              message: "Unable to read CURRENT snapshot manifest for repo: \(displayName)")
            }
            let spec = GitDiffCompareSpec.uncommitted(base: manifest.fingerprint.headSHA)
            return (spec, spec.displayString, rawInput)
        }

        if let normalized = GitDiffSnapshotStore.normalizeSnapshotID(rawInput) {
            if let manifest = try? manifest(normalized) {
                let spec = GitDiffCompareSpec.uncommitted(base: manifest.fingerprint.headSHA)
                return (spec, spec.displayString, rawInput)
            }
            if looksLikeSnapshotID(normalized) {
                throw Failure(code: "gitSnapshotNotFound",
                              message: "Snapshot not found for compare: \(rawInput) in repo: \(displayName)")
            }
        }

        let spec = GitDiffCompareSpec.parse(rawInput)
        let resolved = spec.displayString
        let input = (resolved == rawInput) ? nil : rawInput
        return (spec, resolved, input)
    }

    private func looksLikeSnapshotID(_ value: String) -> Bool {
        let parts = value.split(separator: "/")
        guard parts.count == 2 else { return false }
        let datePart = parts[0]
        let timePart = parts[1]
        guard datePart.count == 10 else { return false }
        let dateChars = Array(datePart)
        guard dateChars.indices.contains(4), dateChars.indices.contains(7) else { return false }
        if dateChars[4] != "-" || dateChars[7] != "-" { return false }
        // swiftlint:disable:next identifier_name
        let dateDigits = dateChars.enumerated().allSatisfy { idx, ch in
            if idx == 4 || idx == 7 { return true }
            return ch.isNumber
        }
        guard dateDigits else { return false }
        let timeParts = timePart.split(separator: "-", maxSplits: 1).map(String.init)
        guard let timeDigits = timeParts.first, timeDigits.count == 4, timeDigits.allSatisfy(\.isNumber)
        else { return false }
        if timeParts.count == 2 {
            guard let suffix = timeParts.last, !suffix.isEmpty, suffix.allSatisfy(\.isNumber) else { return false }
        }
        return true
    }
}
