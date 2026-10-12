import Foundation

struct PromptAssemblyInput {
    private let builder: PromptAssemblyBuilder

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: [
            "kind", "order", "disabled", "duplicateUserInstructionsAtTop", "snippets"
        ])
        let fields = try WireObject(object.value("snippets"), keys: Set(PromptSection.allCases.map(\.rawValue)))
        var snippets: [PromptSection: String] = [:]
        for section in PromptSection.allCases {
            if fields.fields[section.rawValue] is NSNull { continue }
            snippets[section] = try fields.text(section.rawValue)
        }
        builder = try PromptAssemblyBuilder(
            order: Self.sections(object.value("order")),
            disabled: Set(Self.sections(object.value("disabled"))),
            duplicateUserInstructionsAtTop: object.boolean("duplicateUserInstructionsAtTop"),
            snippets: snippets
        )
    }

    private static func sections(_ value: Any) throws -> [PromptSection] {
        guard let names = value as? [String] else { throw BridgeFailure("nativeProtocolError") }
        return try names.map { name in
            guard let section = PromptSection(rawValue: name) else { throw BridgeFailure("nativeProtocolError") }
            return section
        }
    }

    func render() -> [String: Any] {
        ["kind": "promptAssembly", "text": builder.build()]
    }
}
