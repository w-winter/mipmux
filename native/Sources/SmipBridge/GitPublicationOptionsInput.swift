import Foundation

struct GitPublicationOptionsInput {
    private let fields: WireObject

    init(_ value: Any) throws {
        fields = try WireObject(
            value,
            keys: ["kind", "mode", "scope", "snapshotID", "inlineMap", "inlineMode", "inlineMaxLines"]
        )
    }

    func render() throws -> [String: Any] {
        let modeRaw = try fields.text("mode").lowercased()
        guard let mode = GitDiffPublishMode(rawValue: modeRaw) else {
            return ["kind": "gitPublicationOptionsError", "message": "Invalid mode: \(modeRaw)"]
        }
        let scopeRaw = try fields.text("scope").lowercased()
        guard let scope = GitDiffScope(rawValue: scopeRaw) else {
            return ["kind": "gitPublicationOptionsError", "message": "Invalid scope: \(scopeRaw)"]
        }
        let rawID: String? = try fields.value("snapshotID") is NSNull ? nil : fields.text("snapshotID")
        let trimmedID = rawID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let snapshotID = trimmedID.flatMap { value in
            value.isEmpty || value.lowercased() == "auto" ? nil : GitDiffSnapshotStore.normalizeSnapshotID(value)
        }
        return try ["kind": "gitPublicationOptions", "options": [
            "mode": mode.rawValue, "scope": scope.rawValue, "snapshotID": snapshotID as Any? ?? NSNull(),
            "inlineMap": fields.boolean("inlineMap"), "inlineMode": fields.text("inlineMode").lowercased(),
            "inlineMaxLines": max(1, fields.integer("inlineMaxLines"))
        ]]
    }
}
