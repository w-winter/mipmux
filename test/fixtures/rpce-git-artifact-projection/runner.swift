import Foundation

struct ProjectionRequest: Codable {
    let name: String
    let snapshot: String
    let inlineMap: Bool
    let inlineMode: String
    let inlineMaxLines: Int
    let autoSelectedPaths: [String]
    let mapState: String
}

struct PublishedRecord: Codable {
    let kind: String
    let absolutePath: String
    let gitDataRelativePath: String
    let clientAlias: String?
    let selectionDisposition: String

    init(_ artifact: GitDiffPublishedArtifact, directory: URL) {
        kind = String(describing: artifact.kind)
        absolutePath = artifact.absolutePath.replacingOccurrences(of: directory.path, with: "$FIXTURE_DIRECTORY")
        gitDataRelativePath = artifact.gitDataRelativePath
        clientAlias = artifact.clientAlias
        selectionDisposition = String(describing: artifact.selectionDisposition)
    }
}

struct CaseOutput: Codable {
    let name: String
    let reply: ToolResultDTOs.GitToolReplyDTO
    let publishedArtifacts: [PublishedRecord]
    let primarySelectionAliases: [String]
    let advertisedSelectionAliases: [String]
}

struct RunnerOutput: Codable {
    let cases: [CaseOutput]
    let multiRepoReply: ToolResultDTOs.GitToolReplyDTO
    let emptyReasons: [EmptyReasonOutput]
}

struct EmptyReasonInput: Codable {
    let name: String
    let files: Int
    let scope: GitDiffScope
    let requestedPaths: [String]?
    let compare: String
}

struct EmptyReasonOutput: Codable {
    let name: String
    let reason: String?
}

@main struct Runner {
    // swiftlint:disable:next function_body_length
    @MainActor static func main() async throws {
        typealias Reply = ToolResultDTOs.GitToolReplyDTO
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let requests = try JSONDecoder().decode([ProjectionRequest].self, from:
            Data(contentsOf: directory.appendingPathComponent("requests.json")))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var outputs: [CaseOutput] = []
        var repoResults: [Reply.RepoResultDTO] = []
        var manifests: [String: GitDiffSnapshotManifest] = [:]
        var diffs: [Reply.DiffDTO] = []
        for request in requests {
            let snapshotDir = "repos/fixture-repo/\(request.snapshot)"
            let snapshotURL = directory.appendingPathComponent("snapshots/_git_data/\(snapshotDir)")
            let manifest = try decoder.decode(GitDiffSnapshotManifest.self, from:
                Data(contentsOf: snapshotURL.appendingPathComponent("manifest.json")))
            let mapURL = snapshotURL.appendingPathComponent("MAP.txt")
            let originalMap = try Data(contentsOf: mapURL)
            if request.mapState == "missing" {
                try FileManager.default.moveItem(at: mapURL, to: snapshotURL.appendingPathComponent("MAP.saved"))
            } else if request.mapState == "invalid-utf8" {
                try Data([0xFF, 0xFE, 0xFF]).write(to: mapURL)
            }
            let projection = try await MCPGitToolProjection.makeArtifactProjection(
                snapshotDirURL: snapshotURL, snapshotDir: snapshotDir, manifest: manifest,
                compareDisplay: manifest.compare, mode: manifest.mode, inlineMap: request.inlineMap,
                inlineMode: request.inlineMode, inlineMaxLines: request.inlineMaxLines
            )
            if request.mapState == "missing" {
                try FileManager.default.moveItem(at: snapshotURL.appendingPathComponent("MAP.saved"), to: mapURL)
            } else if request.mapState == "invalid-utf8" {
                try originalMap.write(to: mapURL)
            }
            let primary = try await MCPGitToolProjection.makePrimaryArtifactsDTO(
                snapshotDir: snapshotDir, artifacts: projection.artifacts, manifest: manifest,
                autoSelectedPaths: request.autoSelectedPaths
            )
            let reply = assembleReply(projection: projection, primaryArtifacts: primary,
                                      snapshotID: manifest.snapshotID, snapshotDirRel: snapshotDir,
                                      primaryWorktree: nil, combinedWarning: nil)
            let published = projection.publishedArtifacts
            outputs.append(CaseOutput(name: request.name, reply: reply,
                                      publishedArtifacts: published.orderedArtifacts.map { PublishedRecord(
                                          $0,
                                          directory: directory
                                      ) },
                                      primarySelectionAliases: published.primarySelectionArtifacts
                                          .compactMap(\.clientAlias),
                                      advertisedSelectionAliases: published.advertisedSelectionArtifacts
                                          .compactMap(\.clientAlias)))
            if request.name == "quick-selected/brief" || request.name == "deep-empty/brief" {
                repoResults.append(Reply.RepoResultDTO(repoRoot: "/fixture/\(request.snapshot)",
                                                       repoKey: "fixture-repo", repoName: request.snapshot,
                                                       diff: projection.diff,
                                                       snapshotId: manifest.snapshotID, snapshotDir: snapshotDir,
                                                       artifacts: projection.artifacts, summary: projection.summary,
                                                       oneliner: projection.oneliner,
                                                       inputs: projection.inputs, modeDetails: projection.modeDetails,
                                                       inline: projection.inline,
                                                       warning: "  acquisition warning  ",
                                                       emptyReason: projection.emptyReason))
                manifests[snapshotDir] = manifest
                diffs.append(projection.diff)
            }
        }
        repoResults.append(Reply.RepoResultDTO(
            repoRoot: "/fixture/error",
            repoKey: "error",
            error: "fixture acquisition error"
        ))
        let decorated = try await MCPGitToolProjection.decorateArtifactRepoResults(
            repoResults,
            manifestsBySnapshotDir: manifests,
            autoSelectedPaths: ["_git_data/repos/fixture-repo/quick-selected/MAP.txt"],
            readinessWarningsBySnapshotDir: ["repos/fixture-repo/quick-selected": "  readiness warning \n"]
        )
        let aggregate = try await MCPGitToolProjection.makeAggregateDTO(from: diffs, repoCount: repoResults.count)
        let emptyInputs = try JSONDecoder().decode([EmptyReasonInput].self, from:
            Data(contentsOf: directory.appendingPathComponent("empty-reasons.json")))
        let emptyReasons = emptyInputs.map { input in
            EmptyReasonOutput(name: input.name, reason: GitDiffMapBuilder.emptyReason(
                summary: GitDiffSnapshotManifest.Summary(files: input.files, insertions: 0, deletions: 0),
                scope: input.scope, requestedPaths: input.requestedPaths, compareRaw: input.compare
            ))
        }
        let output = RunnerOutput(
            cases: outputs,
            multiRepoReply: Reply(op: "diff", repos: decorated, aggregate: aggregate),
            emptyReasons: emptyReasons
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try FileHandle.standardOutput.write(encoder.encode(output))
    }
}
