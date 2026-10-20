// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: executable-local visibility.
import Foundation

extension String {
    static func splitContentPreservingAllLineEndings(_ content: String) -> [(line: String, ending: String)] {
        guard !content.isEmpty else { return [] }

        var result: [(String, String)] = []
        result.reserveCapacity(32)

        let scalars = content.unicodeScalars
        var lineStart = scalars.startIndex
        var index = scalars.startIndex

        while index < scalars.endIndex {
            let scalar = scalars[index]

            if scalar == "\r" {
                let line = String(scalars[lineStart ..< index])
                let next = scalars.index(after: index)
                if next < scalars.endIndex, scalars[next] == "\n" {
                    result.append((line, "\r\n"))
                    index = scalars.index(after: next)
                    lineStart = index
                } else {
                    result.append((line, "\r"))
                    index = next
                    lineStart = index
                }
            } else if scalar == "\n" {
                let line = String(scalars[lineStart ..< index])
                result.append((line, "\n"))
                index = scalars.index(after: index)
                lineStart = index
            } else {
                index = scalars.index(after: index)
            }
        }

        if lineStart < scalars.endIndex {
            let remainder = String(scalars[lineStart ..< scalars.endIndex])
            result.append((remainder, ""))
        }

        return result
    }
}
