// Retained source layout and diagnostics; CCCC enforces configured complexity limits.
// swiftlint:disable large_tuple opening_brace
// Derived from the RPCE-pinned Swift MCP SDK 5716de85a976a8f70dedc9cb000e50aaa0d8cc5b.
// Modified: retain data-URL recognition/decoding; omit the unconsumed encoder.
import Foundation
import RegexBuilder

public extension Data {
    /// Regex pattern for data URLs
    @inline(__always) private static var dataURLRegex:
        Regex<(Substring, Substring, Substring?, Substring)>
    {
        Regex {
            "data:"
            Capture {
                ZeroOrMore(.reluctant) {
                    CharacterClass.anyOf(",;").inverted
                }
            }
            Optionally {
                ";charset="
                Capture {
                    OneOrMore(.reluctant) {
                        CharacterClass.anyOf(",;").inverted
                    }
                }
            }
            Optionally { ";base64" }
            ","
            Capture {
                ZeroOrMore { .any }
            }
        }
    }

    /// Checks if a given string is a valid data URL.
    ///
    /// - Parameter string: The string to check.
    /// - Returns: `true` if the string is a valid data URL, otherwise `false`.
    /// - SeeAlso: [RFC 2397](https://www.rfc-editor.org/rfc/rfc2397.html)
    static func isDataURL(string: String) -> Bool {
        string.wholeMatch(of: dataURLRegex) != nil
    }

    /// Parses a data URL string into its MIME type and data components.
    ///
    /// - Parameter string: The data URL string to parse.
    /// - Returns: A tuple containing the MIME type and decoded data, or `nil` if parsing fails.
    /// - SeeAlso: [RFC 2397](https://www.rfc-editor.org/rfc/rfc2397.html)
    static func parseDataURL(_ string: String) -> (mimeType: String, data: Data)? {
        guard let match = string.wholeMatch(of: dataURLRegex) else {
            return nil
        }

        // Extract components using strongly typed captures
        let (_, mediatype, charset, encodedData) = match.output

        let isBase64 = string.contains(";base64,")

        // Process MIME type
        var mimeType = mediatype.isEmpty ? "text/plain" : String(mediatype)
        if let charset, !charset.isEmpty, mimeType.starts(with: "text/") {
            mimeType += ";charset=\(charset)"
        }

        // Decode data
        let decodedData: Data
        if isBase64 {
            guard let base64Data = Data(base64Encoded: String(encodedData)) else { return nil }
            decodedData = base64Data
        } else {
            guard
                let percentDecodedData = String(encodedData).removingPercentEncoding?.data(
                    using: .utf8
                )
            else { return nil }
            decodedData = percentDecodedData
        }

        return (mimeType: mimeType, data: decodedData)
    }
}

// swiftlint:enable large_tuple opening_brace
