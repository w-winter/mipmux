// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct RPCEGitSnapshotWorktreeMetadata {
    func metadata(for repoRoot: String) -> GitSnapshotWorktree? {
        let rootURL = URL(fileURLWithPath: repoRoot)
        guard let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: rootURL), layout.isLinkedWorktree else {
            return nil
        }
        let worktreeName = layout.gitDir.lastPathComponent.isEmpty ? nil : layout.gitDir.lastPathComponent
        return GitSnapshotWorktree(isWorktree: true, worktreeName: worktreeName,
                                   worktreeRoot: layout.workTreeRoot.path,
                                   mainWorktreeRoot: layout.knownMainWorktreeRoot?.path,
                                   commonGitDir: layout.commonDir.path)
    }
}
