// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Crypto
import Foundation

struct RPCEGitStatusFingerprint {
    func fingerprint(headSHA: String, baseRef: String, baseRefSHA: String, statusData: Data,
                     attributes: (String) throws -> [FileAttributeKey: Any]) -> GitDiffFingerprint {
        var fingerprintData = Data()
        fingerprintData.append(statusData)
        fingerprintData.append(0)
        fingerprintData.append(Data(baseRefSHA.utf8))
        fingerprintData.append(0)

        // Include per-path size/mtime to invalidate cache when modified file content changes.
        let paths = changedPathsFromPorcelainZ(statusData)
        for path in Set(paths).sorted() {
            fingerprintData.append(Data(path.utf8))
            fingerprintData.append(0)
            if let attrs = try? attributes(path) {
                let size = (attrs[.size] as? NSNumber)?.int64Value ?? -1
                let mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1
                fingerprintData.append(Data("\(size)\t\(mtime)".utf8))
            } else {
                fingerprintData.append(Data("missing".utf8))
            }
            fingerprintData.append(0)
        }
        let statusHash = Self.sha256Hex(fingerprintData)
        return GitDiffFingerprint(headSHA: headSHA, baseRef: baseRef, statusHash: statusHash, generatedAt: Date())
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func changedPathsFromPorcelainZ(_ data: Data) -> [String] {
        guard let text = String(data: data, encoding: .utf8), !text.isEmpty else {
            return []
        }

        let entries = text.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
        var paths: [String] = []
        // swiftlint:disable:next identifier_name
        var i = 0
        while i < entries.count {
            let entry = entries[i]
            guard entry.count >= 3 else {
                i += 1
                continue
            }

            let indexStatus = entry[entry.startIndex]
            let pathStart = entry.index(entry.startIndex, offsetBy: 3)
            let path1 = String(entry[pathStart...])
            guard !path1.isEmpty else {
                i += 1
                continue
            }

            // Renames/copies include a second path after NUL; prefer destination.
            if indexStatus == "R" || indexStatus == "C" {
                if i + 1 < entries.count, !entries[i + 1].isEmpty {
                    paths.append(entries[i + 1])
                } else {
                    paths.append(path1)
                }
                i += 2
                continue
            }

            paths.append(path1)
            i += 1
        }

        return paths
    }
}
