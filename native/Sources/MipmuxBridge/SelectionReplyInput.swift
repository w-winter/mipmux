import Foundation

struct SelectionReplyInput {
    private let collections: RPCESelectionReplyAssembler.SelectionCollections
    private let status: String
    private let codemapAutoEnabled: Bool
    private let invalidPaths: [String]
    private let unmappedPaths: [String]
    private let pendingPaths: [String]
    private let blocks: [String]?
    private let view: String

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: [
            "kind", "entries", "status", "codemapAutoEnabled", "invalidPaths", "unmappedPaths", "pendingPaths",
            "blocks", "view"
        ])
        guard let entries = input.fields["entries"] as? [Any],
              let invalid = input.fields["invalidPaths"] as? [String],
              let unmapped = input.fields["unmappedPaths"] as? [String],
              let pending = input.fields["pendingPaths"] as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        var selected: [RPCESelectionReplyAssembler.SelectedEntry] = []
        var codemap: [RPCESelectionReplyAssembler.CodemapEntry] = []
        var codemapTokens: [UUID: Int] = [:]
        for value in entries {
            let entry = try Self.entry(value)
            switch entry.representation {
            case .full, .slice:
                selected.append(.init(entry: entry.content))
            case let .codemap(origin):
                codemap.append(.init(entry: entry.content, origin: origin))
                codemapTokens[entry.content.file.id] = entry.content.tokens
            }
        }
        collections = .init(selected: selected, codemap: codemap, codeMapUsage: .auto,
                            codemapPresentation: .init(tokensByFileID: codemapTokens))
        status = try input.string("status")
        codemapAutoEnabled = try input.boolean("codemapAutoEnabled")
        invalidPaths = invalid
        unmappedPaths = unmapped
        pendingPaths = pending
        let rawBlocks = try input.value("blocks")
        if rawBlocks is NSNull {
            blocks = nil
        } else if let values = rawBlocks as? [String] {
            blocks = values
        } else { throw BridgeFailure("nativeProtocolError") }
        view = try input.string("view")
        guard ["summary", "files", "content", "codemaps"].contains(view), ["ok", "preview"].contains(status)
        else { throw BridgeFailure("nativeProtocolError") }
    }

    private enum Representation {
        case full
        case slice
        case codemap(RPCESelectionReplyAssembler.CodemapOrigin)
    }

    private static func entry(_ value: Any) throws -> (
        content: RPCESelectionReplyAssembler.CapturedEntry, representation: Representation
    ) {
        guard let object = value as? [String: Any], let kind = object["kind"] as? String
        else { throw BridgeFailure("nativeProtocolError") }
        let keys = ["kind", "path", "rootPath", "pathWithinRoot", "tokens"]
        let specificKeys = kind == "slice" ? ["ranges"] : kind == "codemap" ? ["origin"] : []
        let input = try WireObject(value, keys: Set(keys + specificKeys))
        let file = try RPCESelectionReplyAssembler.CapturedFile(
            id: UUID(), displayPath: input.string("path"), rootPath: input.string("rootPath"),
            pathWithinRoot: input.string("pathWithinRoot")
        )
        let tokens = try input.integer("tokens")
        guard tokens >= 0 else { throw BridgeFailure("nativeProtocolError") }
        let representation: Representation
        let ranges: [LineRange]?
        switch kind {
        case "full": representation = .full; ranges = nil
        case "slice":
            guard let values = input.fields["ranges"] as? [Any], !values.isEmpty
            else { throw BridgeFailure("nativeProtocolError") }
            ranges = try values.map { try LineRange(wire: $0) }
            representation = .slice
        case "codemap":
            guard let origin = try RPCESelectionReplyAssembler.CodemapOrigin(rawValue: input.string("origin"))
            else { throw BridgeFailure("nativeProtocolError") }
            representation = .codemap(origin); ranges = nil
        default: throw BridgeFailure("nativeProtocolError")
        }
        return (.init(file: file, tokens: tokens, lineRanges: ranges), representation)
    }

    func render() async throws -> [String: Any] {
        let files = await RPCESelectionReplyAssembler.buildSelectedFilesReply(
            collections: collections, formatter: .init(), tokens: .init()
        )
        let diagnostics = unmappedPaths.isEmpty && pendingPaths.isEmpty ? nil : ToolResultDTOs.SelectedCodeStructureDTO(
            fileCount: 0, content: "", unmappedPaths: unmappedPaths.isEmpty ? nil : unmappedPaths,
            pendingPaths: pendingPaths.isEmpty ? nil : pendingPaths
        )
        let reply = ToolResultDTOs.SelectionReply(
            files: files.files, totalTokens: files.totalTokens, status: status,
            invalidPaths: invalidPaths.isEmpty ? nil : invalidPaths, blocks: blocks,
            codeStructure: diagnostics, fileSlices: files.fileSlices,
            codemapAutoEnabled: codemapAutoEnabled, summary: files.summary,
            codeMapUsage: files.codeMapUsage
        )
        let projected = RPCESelectionReplyAssembler.applyViewFilter(reply, view: view)
        let encoded = try JSONEncoder().encode(projected)
        guard let output = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        else { throw BridgeFailure("nativeProtocolError") }
        return ["kind": "selectionReply", "reply": output]
    }
}
