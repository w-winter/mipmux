import Foundation

private let maximumWireTokenCount = 9_007_199_254_740_991

struct TokenStatsInput {
    private let fullTokens: Int
    private let sliceTokens: Int
    private let codemapTokens: Int
    private let promptText: String
    private let selectedInstructionsText: String
    private let fileTreeText: String
    private let gitDiffText: String?
    private let metadataText: String?
    private let duplicateUserInstructionsAtTop: Bool

    init(_ value: Any) throws {
        let input = try WireObject(value, keys: [
            "kind", "files", "promptText", "selectedInstructionsText", "fileTreeText", "gitDiffText", "metadataText",
            "duplicateUserInstructionsAtTop"
        ])
        let files = try WireObject(input.value("files"), keys: ["fullTokens", "sliceTokens", "codemapTokens"])
        fullTokens = try files.count("fullTokens")
        sliceTokens = try files.count("sliceTokens")
        codemapTokens = try files.count("codemapTokens")
        promptText = try input.text("promptText")
        selectedInstructionsText = try input.text("selectedInstructionsText")
        fileTreeText = try input.text("fileTreeText")
        gitDiffText = try input.value("gitDiffText") is NSNull ? nil : input.text("gitDiffText")
        metadataText = try input.value("metadataText") is NSNull ? nil : input.text("metadataText")
        duplicateUserInstructionsAtTop = try input.boolean("duplicateUserInstructionsAtTop")
    }

    func render() throws -> [String: Any] {
        let breakdown = TokenCalculationService.calculateComponentBreakdown(
            promptText: promptText, selectedInstructionsText: selectedInstructionsText, fileTreeText: fileTreeText,
            gitDiffText: gitDiffText, metadataText: metadataText,
            duplicateUserInstructionsAtTop: duplicateUserInstructionsAtTop
        )
        let contentTokens = fullTokens + sliceTokens
        let stats = RPCETokenStats.makeTokenStats(
            filesTokens: contentTokens + codemapTokens,
            filesContentTokens: contentTokens > 0 ? contentTokens : nil,
            codemapsTokens: codemapTokens > 0 ? codemapTokens : nil, breakdown: breakdown
        )
        guard stats.total <= maximumWireTokenCount else { throw BridgeFailure("nativeProtocolError") }
        let data = try JSONEncoder().encode(stats)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw BridgeFailure("nativeProtocolError") }
        return ["kind": "tokenStats", "tokenStats": object]
    }
}
