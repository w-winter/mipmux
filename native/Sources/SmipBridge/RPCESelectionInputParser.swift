// Retained source layout and diagnostics; CCCC enforces configured complexity limits.
// swiftlint:disable opening_brace statement_position
import Foundation

struct RPCESelectionInputParser {
    struct ManageSelectionInputs {
        let paths: [String]
        let sliceInputs: [WorkspaceSelectionSliceInput]
        let sliceErrors: [String]
        let hadExplicitSliceSpec: Bool
    }

    static func isLineRangeSuffix(_ suffix: Substring) -> Bool {
        guard let first = suffix.first, first == "L" || first == "l" else { return false }
        let remainder = suffix.dropFirst()
        guard !remainder.isEmpty else { return false }
        let sanitized = remainder.filter { !$0.isWhitespace }
        guard let firstDigit = sanitized.first, firstDigit.isNumber else { return false }
        let allowed = CharacterSet(charactersIn: "0123456789,-;")
        for scalar in sanitized.unicodeScalars where !allowed.contains(scalar) {
            return false
        }
        return true
    }

    func parseManageSelectionInputs(rawPaths: [String], slicesValue: SelectionJSONValue?) -> ManageSelectionInputs {
        let paths = parsePaths(rawPaths)
        var sliceInputs = paths.sliceInputs, sliceErrors = paths.sliceErrors
        let slices = slicesValue?.arrayValue ?? []
        for entry in slices {
            guard let object = entry.objectValue else { continue }
            let result = parseSliceObject(object)
            if let input = result.input { sliceInputs.append(input) }
            sliceErrors.append(contentsOf: result.errors)
        }
        return ManageSelectionInputs(paths: paths.paths, sliceInputs: sliceInputs, sliceErrors: sliceErrors,
                                     hadExplicitSliceSpec: paths.hadExplicitSliceSpec || !slices.isEmpty || !sliceInputs
                                         .isEmpty)
    }

    private enum ParsedPath {
        case literal(String)
        case sliced(path: String, ranges: [LineRange], errors: [String])
    }

    private func parsePaths(_ rawPaths: [String]) -> ManageSelectionInputs {
        var paths: [String] = [], seen: Set<String> = []
        var slices: [WorkspaceSelectionSliceInput] = [], errors: [String] = []
        var explicit = false
        for raw in rawPaths {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let path: String
            switch parsePath(trimmed) {
            case let .literal(value): path = value
            case let .sliced(value, ranges, diagnostics):
                path = value
                explicit = true
                errors.append(contentsOf: diagnostics)
                if !ranges.isEmpty { slices.append(WorkspaceSelectionSliceInput(path: value, ranges: ranges)) }
            }
            if seen.insert(path).inserted { paths.append(path) }
        }
        return ManageSelectionInputs(paths: paths, sliceInputs: slices, sliceErrors: errors,
                                     hadExplicitSliceSpec: explicit || !slices.isEmpty)
    }

    private func parsePath(_ trimmed: String) -> ParsedPath {
        guard let hash = trimmed.lastIndex(of: "#") else { return .literal(trimmed) }
        let start = trimmed.index(after: hash)
        guard start < trimmed.endIndex, Self.isLineRangeSuffix(trimmed[start...]) else { return .literal(trimmed) }
        let base = String(trimmed[..<hash]).trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = String(trimmed[start...].dropFirst())
        let (ranges, invalid) = Self.parseLineRangeTokens(from: payload)
        let errors = invalid.map { "Invalid slice '\($0)' for path '\(trimmed)'" }
        return .sliced(path: base.isEmpty ? trimmed : base, ranges: ranges, errors: errors)
    }

    private func parseSliceObject(_ object: [String: SelectionJSONValue])
        -> (input: WorkspaceSelectionSliceInput?, errors: [String])
    {
        let path = object["path"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty else { return (nil, []) }
        var ranges: [LineRange] = [], errors: [String] = []
        var explicitRangeSpecified = false
        if let values = object["ranges"]?.arrayValue {
            explicitRangeSpecified = true
            for value in values {
                guard let range = value.objectValue else { continue }
                if let parsed = parseRangeObject(range) { ranges.append(parsed) }
                else { errors.append("Invalid slice range for path '\(path)': missing start_line") }
            }
        }
        if let lines = object["lines"]?.stringValue {
            explicitRangeSpecified = true
            let (parsed, invalid) = Self.parseLineRangeTokens(from: lines)
            ranges.append(contentsOf: parsed)
            if !invalid
                .isEmpty { errors.append(contentsOf: invalid.map { "Invalid slice '\($0)' for path '\(path)'" }) }
        }
        return (explicitRangeSpecified ? WorkspaceSelectionSliceInput(path: path, ranges: ranges) : nil, errors)
    }

    private func parseRangeObject(_ object: [String: SelectionJSONValue]) -> LineRange? {
        guard let start = Self.lineNumber(object["start_line"], object["start"]) else { return nil }
        let end = Self.lineNumber(object["end_line"], object["end"]) ?? start
        let rawDescription = object["description"]?.stringValue ?? object["desc"]?.stringValue ?? object["label"]?
            .stringValue
        let trimmed = rawDescription?.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = trimmed?.isEmpty == false ? trimmed : nil
        return LineRange(start: start, end: end, description: description)
    }

    private static func lineNumber(_ primary: SelectionJSONValue?, _ alias: SelectionJSONValue?) -> Int? {
        let first = primary?.intValue, second = primary?.stringValue.flatMap(Int.init)
        let third = alias?.intValue, fourth = alias?.stringValue.flatMap(Int.init)
        return first ?? second ?? third ?? fourth
    }

    static func parseLineRangeTokens(from text: String) -> ([LineRange], [String]) {
        let compact = text
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\t", with: "")
            .replacingOccurrences(of: " ", with: "")
        guard !compact.isEmpty else { return ([], []) }

        let rawTokens = compact.split { ",;".contains($0) }
        var ranges: [LineRange] = []
        var invalid: [String] = []

        for rawToken in rawTokens {
            var token = String(rawToken)
            if token.isEmpty { continue }
            if token.lowercased().hasPrefix("l") {
                token.removeFirst()
            }
            if token.isEmpty {
                invalid.append(String(rawToken))
                continue
            }

            if let dashIndex = token.firstIndex(of: "-") {
                let startPart = String(token[..<dashIndex])
                let endPart = String(token[token.index(after: dashIndex)...])
                if let start = Int(startPart) {
                    let end = Int(endPart) ?? start
                    ranges.append(LineRange(start: start, end: end))
                } else {
                    invalid.append(String(rawToken))
                }
            } else if let value = Int(token) {
                ranges.append(LineRange(start: value, end: value))
            } else {
                invalid.append(String(rawToken))
            }
        }

        return (ranges, invalid)
    }
}

// swiftlint:enable opening_brace statement_position
