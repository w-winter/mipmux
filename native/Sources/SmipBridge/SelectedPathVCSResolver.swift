// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

actor SelectedPathVCSResolver {
    private var jjAvailable: Bool?
    private var resolvedRepoCache: [String: VCSResolvedRepo] = [:]

    private func isJJAvailable() -> Bool {
        if let jjAvailable { return jjAvailable }
        var searchPaths: [String] = []
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            searchPaths.append(contentsOf: path.split(separator: ":").map(String.init))
        }
        searchPaths.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "~/.cargo/bin"]
            .map { ($0 as NSString).expandingTildeInPath })
        let available = searchPaths.contains { directory in
            FileManager.default.isExecutableFile(atPath: (directory as NSString).appendingPathComponent("jj"))
        }
        jjAvailable = available
        return available
    }

    func resolve(from url: URL) -> VCSResolvedRepo? {
        let path = url.standardizedFileURL.path
        if let cached = resolvedRepoCache[path] { return cached }
        guard let resolved = detect(from: url) else { return nil }
        resolvedRepoCache[path] = resolved
        resolvedRepoCache[resolved.rootURL.standardizedFileURL.path] = resolved
        return resolved
    }

    private func detect(from url: URL) -> VCSResolvedRepo? {
        let manager = FileManager.default
        var current = url.standardizedFileURL
        var isDirectory: ObjCBool = false
        if manager.fileExists(atPath: current.path, isDirectory: &isDirectory), !isDirectory.boolValue {
            current = current.deletingLastPathComponent()
        }
        while current.path != "/", current.path != "" {
            if manager.fileExists(atPath: current.appendingPathComponent(".jj").path), isJJAvailable() {
                return VCSResolvedRepo(rootURL: current, backendKind: .jujutsu)
            }
            if let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: current) {
                return VCSResolvedRepo(rootURL: layout.workTreeRoot, backendKind: .git)
            }
            current = current.deletingLastPathComponent()
        }
        _ = isJJAvailable()
        return nil
    }
}
