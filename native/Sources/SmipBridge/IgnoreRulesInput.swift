import Foundation

struct IgnoreRulesInput {
    private let rules: IgnoreRulesSnapshot
    private let queries: [(path: String, isDirectory: Bool)]

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "policy", "controls", "layers", "queries"])
        let policyObject = try fields.value("policy")
        guard let policyFields = policyObject as? [String: Any], let kind = policyFields["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        let policy: IgnoreRulePolicy
        if kind == "git" {
            let source = try WireObject(policyObject, keys: ["kind", "prefix"])
            policy = try .gitRoot(repositoryRelativeRootPrefix: IgnoreRootPrefix(value: source.string("prefix")))
        } else {
            let source = try WireObject(policyObject, keys: ["kind"])
            guard try source.string("kind") == "nonGit" else { throw BridgeFailure("nativeProtocolError") }
            policy = .nonGitRoot
        }
        let controls = try WireObject(fields.value("controls"), keys: [
            "gitignore", "global", "repoIgnore", "cursorignore", "respectRepoIgnore", "respectCursorignore"
        ])
        let authority = try IgnoreRootRules.compileRootAuthority(
            gitignoreContent: Self.optionalText(controls, "gitignore"),
            globalIgnoreContent: Self.text(controls, "global"),
            repoIgnoreContent: Self.optionalText(controls, "repoIgnore"),
            cursorignoreContent: Self.optionalText(controls, "cursorignore")
        )
        let mutable = try IgnoreRootRules.makeRootRules(
            authority: authority, respectRepoIgnore: controls.boolean("respectRepoIgnore"),
            respectCursorignore: controls.boolean("respectCursorignore"), policy: policy
        )
        guard let layers = try fields.value("layers") as? [Any],
              let paths = try fields.value("queries") as? [Any] else { throw BridgeFailure("nativeProtocolError") }
        for value in layers {
            let layer = try WireObject(value, keys: ["content", "directory", "authority"])
            let authority: IgnoreRuleAuthority
            switch try layer.string("authority") {
            case "mandatoryGit": authority = .mandatoryGit
            case "secondary": authority = .secondary
            default: throw BridgeFailure("nativeProtocolError")
            }
            try mutable.addCompiledLayer(
                GitignoreCompiler.compile(
                    content: Self.text(layer, "content"), directoryPath: layer.string("directory")
                ),
                authority: authority
            )
        }
        rules = mutable.snapshot()
        queries = try paths.map { value in
            let query = try WireObject(value, keys: ["path", "isDirectory"])
            return try (query.string("path"), query.boolean("isDirectory"))
        }
    }

    func render() -> [String: Any] {
        let paths = queries.map { query -> [String: Any] in
            let outcome = rules.matchOutcome(
                relativePathComponents: query.path.split(separator: "/"), isDirectory: query.isDirectory
            )
            let match = switch outcome {
            case .ignore: "ignore"
            case .allow: "allow"
            case .noMatch, nil: "none"
            }
            return ["path": query.path, "isDirectory": query.isDirectory,
                    "ignored": rules.isIgnored(relativePath: query.path, isDirectory: query.isDirectory),
                    "match": match, "requiresTraversal": rules.requiresTraversal(for: query.path)]
        }
        let diagnostics = rules.traversalDiagnostics
        return ["kind": "ignoreRules", "paths": paths, "hasNegative": rules.hasAnyNegativePatterns(),
                "traversal": ["exactPrefixCount": diagnostics.exactPrefixCount,
                              "patternHintCount": diagnostics.patternHintCount,
                              "broadPatternHintCount": diagnostics.broadPatternHintCount,
                              "basenameOnlyNegationCount": diagnostics.basenameOnlyNegationCount]]
    }

    private static func text(_ fields: WireObject, _ name: String) throws -> String {
        guard let value = try fields.value(name) as? String else { throw BridgeFailure("nativeProtocolError") }
        return value
    }

    private static func optionalText(_ fields: WireObject, _ name: String) throws -> String? {
        try fields.value(name) is NSNull ? nil : text(fields, name)
    }
}
