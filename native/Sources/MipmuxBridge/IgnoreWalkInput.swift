import Foundation

/// The compiled ignore rules of the current inventory walk, kept between its requests so that each directory sends
/// neither its ancestors' controls nor its root's inputs again. Starting a different walk drops the previous one.
final class IgnoreWalks {
    private struct Root {
        let provider: CapturedIgnoreRulesProvider
        let hierarchical: Bool
    }

    private var walk: String?
    private var roots: [String: Root] = [:]

    fileprivate func start(_ walk: String, root: NativeHandle, compiled: CompiledIgnoreRoot,
                           capture: IgnoreCaptureInput, files: ConfinedFiles) -> (CapturedIgnoreRulesProvider, Bool) {
        if self.walk != walk { self.walk = walk; roots = [:] }
        let provider = CapturedIgnoreRulesProvider(["": compiled.rules], settings: compiled.settings, files: files,
                                                   capture: capture, authority: compiled.authority)
        let hierarchical = compiled.settings.enableHierarchicalIgnores
        roots[root.id] = Root(provider: provider, hierarchical: hierarchical)
        return (provider, hierarchical)
    }

    fileprivate func resume(_ walk: String, root: NativeHandle) throws -> (CapturedIgnoreRulesProvider, Bool) {
        guard self.walk == walk, let root = roots[root.id] else { throw BridgeFailure("nativeProtocolError") }
        return (root.provider, root.hierarchical)
    }
}

/// Lists one directory of an inventory walk and evaluates each regular file and directory in it against the walk's
/// rules, in one request. With hierarchical ignores, a descendant's own controls are captured and compiled first, as a
/// separate capture would. A walk's root request carries the root's captured inputs; its descendants follow their
/// parents.
struct IgnoreWalkInput {
    private enum Directory {
        case root(compiled: CompiledIgnoreRoot, capture: IgnoreCaptureInput)
        case descendant(String)
    }

    private let walk: String
    private let root: NativeHandle
    private let directory: Directory

    init(_ value: Any) throws {
        guard let reference = (value as? [String: Any])?["directory"] as? [String: Any]
        else { throw BridgeFailure("nativeProtocolError") }
        let input: WireObject
        if reference["kind"] as? String == "root" {
            input = try WireObject(value, keys: ["kind", "walk", "root", "directory", "rootInputs", "capture"])
            _ = try WireObject(reference, keys: ["kind"])
            directory = try .root(compiled: CompiledIgnoreRoot(input.value("rootInputs")),
                                  capture: IgnoreCaptureInput(input.value("capture")))
        } else {
            input = try WireObject(value, keys: ["kind", "walk", "root", "directory"])
            let descendant = try WireObject(reference, keys: ["kind", "path"])
            guard try descendant.string("kind") == "descendant" else { throw BridgeFailure("nativeProtocolError") }
            directory = try .descendant(descendant.string("path"))
        }
        walk = try input.string("walk")
        root = try NativeHandle(input.value("root"))
        guard !walk.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        // Descendant captures go through the root request's capture input, so it must name the walked root.
        if case let .root(_, capture) = directory,
           capture.root.id != root.id || capture.root.generation != root.generation {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    func render(files: ConfinedFiles, walks: IgnoreWalks, request: Request) async throws -> [String: Any] {
        let provider: CapturedIgnoreRulesProvider, hierarchical: Bool, path: String?
        switch directory {
        case let .root(compiled, capture):
            (provider, hierarchical) = walks.start(walk, root: root, compiled: compiled, capture: capture, files: files)
            path = nil
        case let .descendant(descendant):
            (provider, hierarchical) = try walks.resume(walk, root: root)
            path = descendant
            if hierarchical { _ = try await provider.rulesForDirectory(descendant) }
        }
        var listed: [(name: String, kind: String)] = []
        var result = try files.list(root, path: path, request: request) { listed.append(($0, $1)) }
        let evaluator = RPCEHierarchicalIgnoreEvaluator(rulesProvider: provider)
        var verdicts: [Any] = []
        for entry in listed {
            guard entry.kind == "file" || entry.kind == "directory" else { verdicts.append(NSNull()); continue }
            let query = (path: path.map { $0 + "/" + entry.name } ?? entry.name, isDirectory: entry.kind == "directory")
            try await verdicts.append(IgnoreHierarchyInput.verdict(query, hierarchical: hierarchical,
                                                                   provider: provider, evaluator: evaluator))
        }
        result["kind"] = "directoryWalked"
        result["verdicts"] = verdicts
        result["directories"] = provider.takeCaptured()
        return result
    }
}
