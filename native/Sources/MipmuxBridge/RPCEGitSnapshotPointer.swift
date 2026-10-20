// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

enum CapturedGitSnapshotPointer {
    case symlink(String)
    case file(Data)
    case missing
}

struct RPCEGitSnapshotPointer {
    func readCurrentPointer(_ pointer: CapturedGitSnapshotPointer, relativeTo rootPath: String) -> String? {
        switch pointer {
        case .missing:
            return nil
        case let .symlink(destination):
            return readSymlinkTarget(destination, rootPath: rootPath)
        case let .file(bytes):
            if let raw = String(data: bytes, encoding: .utf8) {
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            }
            return nil
        }
    }

    private func readSymlinkTarget(_ destination: String, rootPath: String) -> String? {
        let trimmed = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        if trimmed.hasPrefix("/") {
            if trimmed.hasPrefix(rootPath) || trimmed.lowercased().hasPrefix(rootPath.lowercased()) {
                var rel = String(trimmed.dropFirst(rootPath.count))
                if rel.hasPrefix("/") {
                    rel.removeFirst()
                }
                return rel.isEmpty ? nil : rel
            }
        }
        return trimmed
    }
}
