// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct ReviewGitDisplayContext: Equatable {
    let roots: [ReviewGitDisplayRoot]
}

struct ReviewGitDisplayRoot: Equatable {
    let logicalRootPath: String
    let logicalRootName: String
    let physicalRootPath: String

    init(logicalRootPath: String, logicalRootName: String, physicalRootPath: String) {
        self.logicalRootPath = StandardizedPath.absolute(
            (logicalRootPath as NSString).expandingTildeInPath
        )
        self.logicalRootName = logicalRootName
        self.physicalRootPath = StandardizedPath.absolute(
            (physicalRootPath as NSString).expandingTildeInPath
        )
    }
}
