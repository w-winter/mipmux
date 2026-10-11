// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: project the coherent source snapshot directly and bind its DTO to the native wire.
import Foundation

struct RPCEGitStatus {
    nonisolated static func makeStatusDTO(
        _ status: GitStatusPorcelainV2Snapshot
    ) -> StatusDTO {
        var parts: [String] = []
        if let branch = status.branch { parts.append(branch) }
        if let ahead = status.ahead, let behind = status.behind {
            parts.append("+\(ahead) -\(behind)")
        }
        let workingStatus = status
        let counts = [
            workingStatus.staged.isEmpty ? nil : "\(workingStatus.staged.count) staged",
            workingStatus.modified.isEmpty ? nil : "\(workingStatus.modified.count) modified",
            workingStatus.untracked.isEmpty ? nil : "\(workingStatus.untracked.count) untracked"
        ].compactMap(\.self)
        if !counts.isEmpty {
            parts.append(counts.joined(separator: ", "))
        }
        return StatusDTO(
            branch: status.branch,
            upstream: status.upstream,
            ahead: status.ahead,
            behind: status.behind,
            staged: workingStatus.staged,
            modified: workingStatus.modified,
            untracked: workingStatus.untracked,
            summary: parts.joined(separator: " | ")
        )
    }

    func project(_ output: String) throws -> [String: Any] {
        do {
            let status = try GitStatusPorcelainV2Parser.parse(output)
            let bytes = try JSONEncoder().encode(Self.makeStatusDTO(status))
            guard let fields = try decodeWireJSON(bytes) as? [String: Any] else {
                throw BridgeFailure("nativeProtocolError")
            }
            return ["kind": "gitStatus", "status": fields]
        } catch let error as VCSError {
            return ["kind": "gitStatusError", "message": error.localizedDescription]
        }
    }
}
