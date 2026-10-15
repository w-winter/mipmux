// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct SelectedPathVCSResolver {
    private let jjAvailable: Bool

    init() {
        var searchPaths: [String] = []
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            searchPaths.append(contentsOf: path.split(separator: ":").map(String.init))
        }
        searchPaths.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "~/.cargo/bin"]
            .map { ($0 as NSString).expandingTildeInPath })
        jjAvailable = searchPaths.contains { directory in
            FileManager.default.isExecutableFile(atPath: (directory as NSString).appendingPathComponent("jj"))
        }
    }

    func resolve(from url: URL) -> VCSResolvedRepo? {
        let manager = FileManager.default
        var current = url.standardizedFileURL
        var isDirectory: ObjCBool = false
        if manager.fileExists(atPath: current.path, isDirectory: &isDirectory), !isDirectory.boolValue {
            current = current.deletingLastPathComponent()
        }
        while true {
            if jjAvailable, manager.fileExists(atPath: current.appendingPathComponent(".jj").path) {
                return VCSResolvedRepo(rootURL: current, backendKind: .jujutsu)
            }
            if let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: current) {
                return VCSResolvedRepo(rootURL: layout.workTreeRoot, backendKind: .git)
            }
            let parent = current.deletingLastPathComponent().standardizedFileURL
            guard parent.path != current.path else { return nil }
            current = parent
        }
    }
}
