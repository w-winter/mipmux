import Foundation

struct GitArtifactProjectionInput {
    private struct Single: Decodable {
        let snapshotDir: String
        let snapshotDirectoryPath: String
        let manifest: String
        let availablePaths: Set<String>
        let mapBytes: String?
        let compareDisplay: String
        let mode: GitDiffPublishMode
        let inlineMap: Bool
        let inlineMode: String
        let inlineMaxLines: Int
        let autoSelectedPaths: [String]
        let worktree: RPCEGitReply.WorktreeDTO?
        let warning: String?
    }

    private struct Multiple: Decodable {
        let repos: [RPCEGitReply.RepoResultDTO]
        let manifests: [String: String]
        let autoSelectedPaths: [String]
        let readinessWarnings: [String: String]
    }

    private enum Work {
        case single(Single)
        case multiple(Multiple)
    }

    private let work: Work

    init(_ value: Any) throws {
        guard let fields = value as? [String: Any], let kind = fields["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        let bytes = try JSONSerialization.data(withJSONObject: fields)
        if kind == "projectGitArtifacts" {
            _ = try WireObject(
                value,
                keys: ["kind", "snapshotDir", "snapshotDirectoryPath", "manifest", "availablePaths",
                       "mapBytes", "compareDisplay", "mode", "inlineMap", "inlineMode",
                       "inlineMaxLines",
                       "autoSelectedPaths", "worktree", "warning"]
            )
            work = try .single(JSONDecoder().decode(Single.self, from: bytes))
        } else {
            _ = try WireObject(value, keys: ["kind", "repos", "manifests", "autoSelectedPaths", "readinessWarnings"])
            work = try .multiple(JSONDecoder().decode(Multiple.self, from: bytes))
        }
    }

    func render() throws -> [String: Any] {
        switch work {
        case let .single(input):
            do {
                return try renderSingle(input)
            } catch let error as GitDiffPublishedArtifactError {
                return ["kind": "gitArtifactProjectionError", "message": error.localizedDescription]
            }
        case let .multiple(input):
            let manifests = try input.manifests.mapValues(Self.decodeManifest)
            let repos = try RPCEGitArtifactProjection.decorateArtifactRepoResults(
                input.repos, manifestsBySnapshotDir: manifests, autoSelectedPaths: input.autoSelectedPaths,
                readinessWarningsBySnapshotDir: input.readinessWarnings
            )
            let aggregate = try RPCEGitArtifactProjection.makeAggregateDTO(
                from: input.repos.compactMap(\.diff), repoCount: input.repos.count
            )
            let reply = RPCEGitReply(op: "diff", repos: repos, aggregate: aggregate)
            return try ["kind": "gitArtifactRepos", "reply": decodeWireJSON(JSONEncoder().encode(reply))]
        }
    }

    private func renderSingle(_ input: Single) throws -> [String: Any] {
        let manifest = try Self.decodeManifest(input.manifest)
        let mapText = try input.mapBytes.flatMap { try String(data: Self.decodeBytes($0), encoding: .utf8) }
        let projection = try RPCEGitArtifactProjection.makeArtifactProjection(
            snapshotDirURL: URL(fileURLWithPath: input.snapshotDirectoryPath), snapshotDir: input.snapshotDir,
            manifest: manifest, compareDisplay: input.compareDisplay, mode: input.mode, inlineMap: input.inlineMap,
            inlineMode: input.inlineMode, inlineMaxLines: input.inlineMaxLines,
            availablePaths: input.availablePaths, mapText: mapText
        )
        let primaryArtifacts = try RPCEGitArtifactProjection.makePrimaryArtifactsDTO(
            snapshotDir: input.snapshotDir, artifacts: projection.artifacts, manifest: manifest,
            autoSelectedPaths: input.autoSelectedPaths
        )
        let reply = RPCEGitReply(
            op: "diff", diff: projection.diff, worktree: input.worktree,
            snapshotId: manifest.snapshotID, snapshotDir: input.snapshotDir, artifacts: projection.artifacts,
            primaryArtifacts: primaryArtifacts, summary: projection.summary, oneliner: projection.oneliner,
            inputs: projection.inputs, modeDetails: projection.modeDetails, inline: projection.inline,
            warning: input.warning, emptyReason: projection.emptyReason
        )
        let published = projection.publishedArtifacts
        let records = published.orderedArtifacts.map { artifact in
            ["kind": String(describing: artifact.kind), "absolutePath": artifact.absolutePath,
             "gitDataRelativePath": artifact.gitDataRelativePath,
             "clientAlias": artifact.clientAlias as Any? ?? NSNull(),
             "selectionDisposition": String(describing: artifact.selectionDisposition)]
        }
        return try ["kind": "gitArtifacts", "reply": decodeWireJSON(JSONEncoder().encode(reply)),
                    "publishedArtifacts": records,
                    "primarySelectionAliases": published.primarySelectionArtifacts.compactMap(\.clientAlias),
                    "advertisedSelectionAliases": published.advertisedSelectionArtifacts.compactMap(\.clientAlias)]
    }

    private static func decodeBytes(_ encoded: String) throws -> Data {
        guard let bytes = Data(base64Encoded: encoded), bytes.base64EncodedString() == encoded else {
            throw BridgeFailure("nativeProtocolError")
        }
        return bytes
    }

    private static func decodeManifest(_ encoded: String) throws -> GitDiffSnapshotManifest {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(GitDiffSnapshotManifest.self, from: decodeBytes(encoded))
    }
}
