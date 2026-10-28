import Foundation

struct IgnoreHierarchyInput {
    private let byDirectory: [String: IgnoreRules]
    private let settings: IgnoreSettings
    private let queries: [(path: String, isDirectory: Bool)]
    private let hierarchical: Bool
    private let capture: IgnoreCaptureInput
    private let authority: [String: Any]

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "capture", "rootInputs", "directories", "queries"])
        let root = try WireObject(fields.value("rootInputs"), keys: ["kind", "authority", "settings", "controls"])
        capture = try IgnoreCaptureInput(fields.value("capture"))
        let settings = try IgnoreSettings(root.value("settings"))
        self.settings = settings
        hierarchical = settings.enableHierarchicalIgnores
        let authority = try root.value("authority")
        guard let object = authority as? [String: Any], let kind = object["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        self.authority = object
        let policy: IgnoreRulePolicy
        if kind == "git" {
            let captured = try WireObject(authority, keys: [
                "kind", "prefix", "repositoryRoot", "gitDirectory", "commonDirectory"
            ])
            policy = try .gitRoot(repositoryRelativeRootPrefix: IgnoreRootPrefix(value: captured.string("prefix")))
        } else {
            _ = try WireObject(authority, keys: ["kind"])
            guard kind == "nonGit" else { throw BridgeFailure("nativeProtocolError") }
            policy = .nonGitRoot
        }
        guard let inputs = try root.value("controls") as? [Any],
              let directories = try fields.value("directories") as? [Any],
              let queries = try fields.value("queries") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        let rules = IgnoreRules(policy: policy)
        try Self.apply(inputs, to: rules, settings: settings, root: true)
        var byDirectory = ["": rules]
        for entry in directories {
            let directory = try WireObject(entry, keys: ["path", "controls"])
            let path = try directory.string("path")
            let parent = (path as NSString).deletingLastPathComponent
            guard !path.isEmpty, let inherited = byDirectory[parent],
                  let controls = try directory.value("controls") as? [Any]
            else {
                throw BridgeFailure("nativeProtocolError")
            }
            let next = inherited.clone()
            try Self.apply(controls, to: next, settings: settings, root: false)
            byDirectory[path] = next
        }
        self.byDirectory = byDirectory
        self.queries = try queries.map { entry in
            let query = try WireObject(entry, keys: ["path", "isDirectory"])
            return try (query.string("path"), query.boolean("isDirectory"))
        }
    }

    fileprivate static func apply(_ inputs: [Any], to rules: IgnoreRules, settings: IgnoreSettings, root: Bool) throws {
        for entry in inputs {
            let input = try WireObject(entry, keys: ["path", "directory", "name", "authority", "content"])
            let content = try input.value("content")
            guard let fields = content as? [String: Any], let kind = fields["kind"] as? String else {
                throw BridgeFailure("nativeProtocolError")
            }
            if kind == "present" {
                let captured = try WireObject(content, keys: ["kind", "resolvedPath", "identity", "text"])
                guard let text = try captured.value("text") as? String else {
                    throw BridgeFailure("nativeProtocolError")
                }
                let authority: IgnoreRuleAuthority = try input.string("authority") == "mandatoryGit"
                    ? .mandatoryGit : .secondary
                try rules.addCompiledLayer(
                    GitignoreCompiler.compile(content: text, directoryPath: input.string("directory")),
                    authority: authority
                )
            } else if kind != "absent", kind != "unavailable" {
                throw BridgeFailure("nativeProtocolError")
            }
            if root, try input.string("directory").isEmpty, try input.string("name") == ".gitignore" {
                rules.addCompiledLayer(GitignoreCompiler.compile(content: settings.global), authority: .secondary)
            }
        }
    }

    func render(files: ConfinedFiles) async throws -> [String: Any] {
        let provider = CapturedIgnoreRulesProvider(
            byDirectory, settings: settings, files: files, capture: capture, authority: authority
        )
        let evaluator = RPCEHierarchicalIgnoreEvaluator(rulesProvider: provider)
        var paths: [[String: Any]] = []
        for query in queries {
            try await paths.append(verdict(query, provider: provider, evaluator: evaluator))
        }
        return ["kind": "ignoreHierarchy", "paths": paths, "directories": provider.captured]
    }

    private func verdict(_ query: (path: String, isDirectory: Bool), provider: CapturedIgnoreRulesProvider,
                         evaluator: RPCEHierarchicalIgnoreEvaluator) async throws -> [String: Any] {
        let ignored = hierarchical
            ? try await evaluator.isIgnored(relativePath: query.path, isDirectory: query.isDirectory)
            : provider.root.isIgnored(relativePath: query.path, isDirectory: query.isDirectory)
        var verdict: [String: Any] = ["path": query.path, "isDirectory": query.isDirectory, "ignored": ignored]
        if query.isDirectory {
            let parent = (query.path as NSString).deletingLastPathComponent
            let rules = hierarchical ? try await provider.rulesForDirectory(parent) : provider.root
            let traversal = rules.requiresTraversal(for: query.path)
            verdict["requiresTraversal"] = traversal
            verdict["directoryIncluded"] = !rules.isIgnored(relativePath: query.path, isDirectory: true)
                || traversal
        }
        return verdict
    }
}

private final class CapturedIgnoreRulesProvider: RPCEHierarchicalIgnoreEvaluator.RulesProvider {
    private var byDirectory: [String: IgnoreRules]
    private let settings: IgnoreSettings
    private let files: ConfinedFiles
    private let capture: IgnoreCaptureInput
    private let authority: [String: Any]
    private(set) var captured: [[String: Any]] = []
    var root: IgnoreRules {
        byDirectory[""]!
    }

    init(
        _ byDirectory: [String: IgnoreRules], settings: IgnoreSettings,
        files: ConfinedFiles, capture: IgnoreCaptureInput, authority: [String: Any]
    ) {
        self.byDirectory = byDirectory
        self.settings = settings
        self.files = files
        self.capture = capture
        self.authority = authority
    }

    func rulesForDirectory(_ directoryPath: String) async throws -> IgnoreRules {
        if let rules = byDirectory[directoryPath] { return rules }
        guard !directoryPath.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        let parent = (directoryPath as NSString).deletingLastPathComponent
        let inherited = try await rulesForDirectory(parent)
        let input = try files.captureIgnoreInputs(capture.atDirectory(directoryPath))
        guard let capturedAuthority = input["authority"] as? [String: Any],
              NSDictionary(dictionary: capturedAuthority).isEqual(to: authority),
              let controls = input["controls"] as? [Any] else { throw BridgeFailure("policyChanged") }
        let next = inherited.clone()
        try IgnoreHierarchyInput.apply(controls, to: next, settings: settings, root: false)
        byDirectory[directoryPath] = next
        captured.append(["path": directoryPath, "controls": controls])
        return next
    }
}
