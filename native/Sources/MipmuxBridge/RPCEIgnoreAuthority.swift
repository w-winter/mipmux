// Derived from RPCE IgnoreRulesAppIntegration.swift:61-117.
// Modified: retain the validated layout alongside the policy for scoped metadata acquisition.
import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

enum RPCEIgnoreAuthority: Equatable {
    case nonGit
    case git(prefix: IgnoreRootPrefix, layout: GitRepositoryLayout)

    static func resolve(_ rawRoot: URL) throws -> RPCEIgnoreAuthority {
        let loadedRoot = rawRoot.resolvingSymlinksInPath().standardizedFileURL
        var loadedStatus = stat()
        guard lstat(loadedRoot.path, &loadedStatus) == 0,
              loadedStatus.st_mode & S_IFMT == S_IFDIR
        else { throw BridgeFailure("ambiguousGitTopology") }

        var candidate = loadedRoot
        while true {
            let dotGit = candidate.appendingPathComponent(".git")
            var dotGitStatus = stat()
            if lstat(dotGit.path, &dotGitStatus) == 0 {
                let kind = dotGitStatus.st_mode & S_IFMT
                guard kind == S_IFDIR || kind == S_IFREG,
                      let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: candidate),
                      validatedContainingGitLayout(layout)
                else { throw BridgeFailure("ambiguousGitTopology") }
                let repositoryRoot = layout.workTreeRoot.resolvingSymlinksInPath().standardizedFileURL
                guard repositoryRoot == candidate,
                      loadedRoot.path == repositoryRoot.path
                      || loadedRoot.path.hasPrefix(repositoryRoot.path + "/")
                else { throw BridgeFailure("ambiguousGitTopology") }
                let relativePath = loadedRoot.path == repositoryRoot.path
                    ? ""
                    : String(loadedRoot.path.dropFirst(repositoryRoot.path.count + 1))
                let prefix = IgnoreRootPrefix(value: relativePath)
                guard prefix.value.split(separator: "/").first != ".git" else {
                    throw BridgeFailure("ambiguousGitTopology")
                }
                return .git(prefix: prefix, layout: layout)
            }
            guard errno == ENOENT else { throw BridgeFailure("nativeIOFailed", errno) }
            guard candidate.path != "/" else { break }
            let parent = candidate.deletingLastPathComponent()
            guard parent.path != candidate.path else { break }
            candidate = parent
        }
        return .nonGit
    }

    private static func validatedContainingGitLayout(_ layout: GitRepositoryLayout) -> Bool {
        func isRegularFile(_ url: URL) -> Bool {
            var value = stat()
            return lstat(url.path, &value) == 0 && value.st_mode & S_IFMT == S_IFREG
        }
        func isDirectory(_ url: URL) -> Bool {
            var value = stat()
            return lstat(url.path, &value) == 0 && value.st_mode & S_IFMT == S_IFDIR
        }
        return isDirectory(layout.gitDir)
            && isDirectory(layout.commonDir)
            && isRegularFile(layout.gitDir.appendingPathComponent("HEAD"))
            && isRegularFile(layout.commonDir.appendingPathComponent("config"))
            && isDirectory(layout.commonDir.appendingPathComponent("objects"))
    }
}
