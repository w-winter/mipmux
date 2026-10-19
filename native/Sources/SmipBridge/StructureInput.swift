import Foundation

struct StructureInput: Decodable {
    struct Signature: Decodable {
        let imports: [String]
        let apiDescription: String

        func rendered(path: String) -> StructureRenderedSignature {
            let text = (["File: \(path)", "Imports:"] + imports.map { "  - \($0)" })
                .joined(separator: "\n") + apiDescription
            return StructureRenderedSignature(text: text, tokenCount: TokenCalculationService.estimateTokens(for: text))
        }
    }

    struct File: Decodable {
        let id: UUID
        let path: String
        let state: StructureSlotState?
        let definitions: [String]
        let references: [String]
        let signature: Signature?

        var contribution: StructureContribution {
            func names(_ values: [String]) -> [String] {
                Set(values.map(\.precomposedStringWithCanonicalMapping))
                    .sorted(by: WorkspaceCodemapGraphOrdering.utf8Precedes)
            }
            return StructureContribution(
                sortedUniqueDefinitions: names(definitions),
                sortedUniqueReferences: names(references)
            )
        }
    }

    struct Root: Decodable {
        let id: UUID
        let name: String
        let complete: Bool
        let files: [File]
        let canonicalPath: String
        let directories: [String]

        var epoch: WorkspaceCodemapRootEpoch {
            WorkspaceCodemapRootEpoch(rootID: id, rootLifetimeID: id)
        }
    }

    struct Selector: Decodable, Hashable {
        // swiftlint:disable:next nesting
        enum Kind: String, Decodable { case file, directory }
        let kind: Kind
        let root: String
        let path: String
    }

    struct SeedInput: Decodable {
        // swiftlint:disable:next nesting
        enum Kind: String, Decodable { case paths, selected }
        let kind: Kind
        let selectors: [Selector]
    }

    let seedInput: SeedInput
    let kind: String
    let inventoryDigest: String
    let codeMapsGloballyDisabled: Bool
    let roots: [Root]
    let expand: String
    let depth: Int
    let signatures: Bool
    let size: WorkspaceCodemapGraphOutputSize

    init(_ value: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        self = try JSONDecoder().decode(Self.self, from: data)
        guard kind == "queryStructure", (1 ... 4).contains(depth),
              ["none", "uses", "used_by", "both"].contains(expand),
              Set(roots.map(\.id)).count == roots.count,
              Set(roots.map(\.name)).count == roots.count,
              seedInput.kind != .paths || (1 ... 256).contains(seedInput.selectors.count)
        else { throw BridgeFailure("nativeProtocolError") }
        for selector in seedInput.selectors {
            guard Self.relativePath(selector.path, allowsRoot: selector.kind == .directory)
            else { throw BridgeFailure("nativeProtocolError") }
        }
        var seenFiles = Set<UUID>()
        for root in roots {
            guard !root.name.isEmpty, root.canonicalPath.hasPrefix("/"),
                  !root.canonicalPath.utf8.contains(0),
                  root.directories.allSatisfy({ Self.relativePath($0, allowsRoot: false) }),
                  Set(root.files.map { Data($0.path.utf8) }).count == root.files.count
            else { throw BridgeFailure("nativeProtocolError") }
            for file in root.files {
                guard seenFiles.insert(file.id).inserted, Self.relativePath(file.path, allowsRoot: false)
                else { throw BridgeFailure("nativeProtocolError") }
            }
        }
    }

    private static func relativePath(_ path: String, allowsRoot: Bool) -> Bool {
        if path.isEmpty { return allowsRoot }
        return !path.hasPrefix("/") && !path.utf8.contains(0) &&
            path.components(separatedBy: "/").allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    func render() throws -> [String: Any] {
        if codeMapsGloballyDisabled {
            return try encoded(RPCEStructureReply.codeStructureUnavailableReply(issue: .init(
                code: "codemaps_disabled", phase: "graph_snapshot", path: nil, retryable: false,
                retryAfterMilliseconds: nil, attempted: nil, limit: nil,
                message: "Codemap generation is disabled."
            ), size: size, worktreeScope: nil))
        }
        let policy = WorkspaceCodemapGraphPolicy.initial
        let budget = policy.queryBudget(size: size, includesSignatures: signatures)
        let direction: WorkspaceCodemapStructureTraversalDirection? = switch expand {
        case "uses": .referencedDefinitions
        case "used_by": .referrers
        case "both": .both
        default: nil
        }
        let aggregate = try StructureRootQueries.query(
            roots: RPCEStructureSeedResolver.resolve(seedInput, roots: roots),
            inventoryDigest: inventoryDigest,
            direction: direction,
            maximumDepth: depth,
            budget: budget
        )
        if aggregate.roots.isEmpty {
            return try encoded(unavailableReply())
        }
        var rendered: [UUID: StructureRenderedSignature] = [:]
        if signatures {
            for root in roots {
                for file in root.files {
                    if let signature = file.signature {
                        rendered[file.id] = signature.rendered(path: root.name + "/" + file.path)
                    }
                }
            }
        }
        let presentation = signatures ? StructureSignaturePresentation(
            renderedEntriesByFileID: rendered,
            issues: [],
            coverage: CodeStructureSignatureIssueCoverage()
        ) : nil
        let dto = RPCEStructureReply.codeStructureReplyDTO(
            aggregate: aggregate,
            presentation: presentation,
            revalidation: [:],
            includesSignatures: signatures,
            budget: budget,
            size: size,
            worktreeScope: nil
        )
        return try encoded(dto)
    }

    private func unavailableReply() -> ToolResultDTOs.CodeStructureReplyDTO {
        let requested = seedInput.kind == .paths ? seedInput.selectors.first.map {
            $0.path.isEmpty ? $0.root : $0.root + "/" + $0.path
        } : nil
        return RPCEStructureReply.codeStructureUnavailableReply(issue: .init(
            code: "path_not_found", phase: "seed_resolution", path: requested, retryable: false,
            retryAfterMilliseconds: nil, attempted: nil, limit: nil,
            message: "No requested path resolved to a file."
        ), size: size, worktreeScope: nil)
    }

    private func encoded(_ dto: ToolResultDTOs.CodeStructureReplyDTO) throws -> [String: Any] {
        let encoded = try JSONEncoder().encode(dto)
        return try ["kind": "structure", "reply": JSONSerialization.jsonObject(with: encoded),
                    "text": RPCEStructureFormatter.formatCodeStructure(dto: dto)]
    }
}

extension StructureSlotState: Decodable {}
