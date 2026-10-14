import Foundation

struct GitWorktreeInput {
    private struct ReplyInput {
        let rootName: String
        let mainRoot: String?
        let branch: String?
        let head: String?
        let mainBranch: String?
        let mainHead: String?
    }

    private enum Work {
        case prepare(String)
        case config(String)
        case listing([GitWorktreePorcelainRecord], String?)
        case reply(ReplyInput)
    }

    private let repoRoot: String
    private let work: Work

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any], let kind = raw["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        let fields: WireObject
        switch kind {
        case "prepareGitWorktreeMainRoot":
            fields = try WireObject(value, keys: ["kind", "repoRoot", "listing"])
            work = try .prepare(fields.text("listing"))
        case "resolveGitWorktreeConfig":
            fields = try WireObject(value, keys: ["kind", "repoRoot", "config"])
            work = try .config(fields.string("config"))
        case "projectGitWorktreeListing":
            fields = try WireObject(value, keys: ["kind", "repoRoot", "records", "mainRoot"])
            let records = try JSONDecoder().decode([GitWorktreePorcelainRecord].self,
                                                   from: JSONSerialization
                                                       .data(withJSONObject: fields.value("records")))
            work = try .listing(records, Self.optionalText(fields, "mainRoot"))
        default:
            fields = try WireObject(value, keys: [
                "kind", "repoRoot", "rootName", "mainRoot", "branch", "head", "mainBranch", "mainHead"
            ])
            work = try .reply(ReplyInput(rootName: fields.string("rootName"),
                                         mainRoot: Self.optionalText(fields, "mainRoot"),
                                         branch: Self.optionalText(fields, "branch"),
                                         head: Self.optionalText(fields, "head"),
                                         mainBranch: Self.optionalText(fields, "mainBranch"),
                                         mainHead: Self.optionalText(fields, "mainHead")))
        }
        repoRoot = try fields.string("repoRoot")
    }

    func render() throws -> [String: Any] {
        guard let layout = GitRepositoryLayoutResolver.resolve(atWorkTreeRoot: URL(fileURLWithPath: repoRoot))
        else { throw BridgeFailure("gitRepositoryChanged") }
        switch work {
        case let .prepare(listing):
            let records: [GitWorktreePorcelainRecord]
            do {
                records = try GitWorktreePorcelainParser.parse(listing, format: .nulTerminated)
            } catch {
                return ["kind": "gitWorktreeListingError", "message": error.localizedDescription]
            }
            let queries: [[String: Any]] = layout.knownMainWorktreeRoot == nil ? [
                ["directory": repoRoot, "arguments": ["config", "--path", "--get", "core.worktree"]],
                ["directory": layout.commonDir.path, "arguments": [
                    "--git-dir", layout.commonDir.path, "config", "--worktree", "--path", "--get", "core.worktree"
                ]]
            ] : []
            let values = try decodeWireJSON(JSONEncoder().encode(records))
            return ["kind": "gitWorktreePlan", "mainRoot": layout.knownMainWorktreeRoot?.path as Any? ?? NSNull(),
                    "records": values, "queries": queries]
        case let .config(value):
            let root = RPCEGitWorktreeListing().resolveMainRoot(layout: layout, configValue: value)
            return ["kind": "gitWorktreeMainRoot", "path": root?.path as Any? ?? NSNull()]
        case let .listing(records, mainRoot):
            do {
                let listing = try RPCEGitWorktreeListing().resolve(layout: layout,
                                                                   resolvedMainRoot: mainRoot
                                                                       .map { URL(fileURLWithPath: $0) },
                                                                   records: records)
                return ["kind": "gitWorktreeListing", "mainRoot": listing.mainRoot?.path as Any? ?? NSNull(),
                        "paths": listing.paths]
            } catch {
                return ["kind": "gitWorktreeListingError", "message": error.localizedDescription]
            }
        case let .reply(input):
            guard layout.isLinkedWorktree else { throw BridgeFailure("gitRepositoryChanged") }
            let worktree = RPCEGitReply.WorktreeDTO(isWorktree: true,
                                                    worktreeName: layout.gitDir.lastPathComponent.isEmpty ? nil : layout
                                                        .gitDir.lastPathComponent,
                                                    worktreeRoot: layout.workTreeRoot.path,
                                                    commonGitDir: layout.commonDir.path,
                                                    mainWorktreeRoot: input.mainRoot,
                                                    worktreeBranch: Self.trim(input.branch),
                                                    mainBranch: Self.trim(input.mainBranch),
                                                    worktreeHead: Self.trim(input.head).map { String($0.prefix(7)) },
                                                    mainHead: Self.trim(input.mainHead).map { String($0.prefix(7)) })
            return try ["kind": "gitWorktreeReply", "worktree": decodeWireJSON(JSONEncoder().encode(worktree)),
                        "warning": Self.warning(worktree, rootName: input.rootName)]
        }
    }

    private static func optionalText(_ fields: WireObject, _ name: String) throws -> String? {
        try fields.value(name) is NSNull ? nil : fields.string(name)
    }

    private static func trim(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func warning(_ worktree: RPCEGitReply.WorktreeDTO, rootName: String) -> String {
        var parts = ["[Worktree] Git operations are scoped to this checkout."]
        if let branch = worktree.worktreeBranch {
            let head = worktree.worktreeHead.map { "@\($0)" } ?? ""
            parts.append("This: \(branch)\(head).")
        }
        if let mainRoot = worktree.mainWorktreeRoot {
            var mainLabel = "Main: \(mainRoot)"
            if let mainBranch = worktree.mainBranch {
                let head = worktree.mainHead.map { "@\($0)" } ?? ""
                mainLabel += " (\(mainBranch)\(head))"
            }
            parts.append(mainLabel + ".")
            parts
                .append(
                    "Use root=\"\(rootName)\" with worktree=\"\(mainRoot)\" for main checkout, "
                        + "or compare=\"main\" for trunk diff."
                )
        } else {
            parts
                .append(
                    "The primary checkout path could not be resolved. "
                        + "Pass its listed full path as worktree with root=\"\(rootName)\" to target it; "
                        + "compare=\"main\" still selects the trunk comparison base."
                )
        }
        return parts.joined(separator: " ")
    }
}
