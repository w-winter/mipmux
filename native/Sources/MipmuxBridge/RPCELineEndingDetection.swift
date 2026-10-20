// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: executable-local visibility and explicit C module import.
import Foundation
import RepoPromptC

extension String {
    static func splitContentPreservingLineEndings(_ content: String) -> ([String], String) {
        content.withCString { contentPtr in
            guard let result = repo_split_content_preserving_endings(contentPtr) else {
                return ([], "\n")
            }
            defer { repo_free_split_result(result) }

            // Convert C string array to Swift array
            var lines: [String] = []
            // swiftlint:disable:next identifier_name
            for i in 0 ..< result.pointee.line_count {
                if let linePtr = result.pointee.lines.advanced(by: Int(i)).pointee {
                    lines.append(String(cString: linePtr))
                }
            }

            // Get detected ending
            let detectedEnding = result.pointee.detected_ending != nil
                ? String(cString: result.pointee.detected_ending)
                : "\n"

            return (lines, detectedEnding)
        }
    }
}
