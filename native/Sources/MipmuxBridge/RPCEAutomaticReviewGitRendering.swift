// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation

struct ReviewGitCheckout: Equatable {
    let checkoutRootPath: String
    let displayLabel: String
    let selectedPaths: [String]
}

enum ReviewGitCheckoutOutcome: Equatable {
    case diff(checkout: ReviewGitCheckout, text: String)
    case noChanges(checkout: ReviewGitCheckout)
    case baseResolutionFailed(checkout: ReviewGitCheckout, summary: String)
    case commandFailed(checkout: ReviewGitCheckout, summary: String)

    var isSuccessful: Bool {
        switch self {
        case .diff, .noChanges: true
        case .baseResolutionFailed, .commandFailed: false
        }
    }
}

struct RPCEAutomaticReviewGitRendering {
    enum Completeness: String { case complete, partial, failed }

    func renderText(
        outcomes: [ReviewGitCheckoutOutcome],
        pathIssues: [ReviewGitPathIssue],
        completeness: Completeness,
        bodySpans: inout [[String: Int]]
    ) -> String? {
        let diffs = outcomes.compactMap { outcome -> (ReviewGitCheckout, String)? in
            guard case let .diff(checkout, text) = outcome else { return nil }
            return (checkout, text)
        }

        if completeness == .complete, outcomes.count == 1, let onlyDiff = diffs.first {
            bodySpans.append(["offset": 0, "length": onlyDiff.1.utf8.count])
            return onlyDiff.1
        }

        var offset = 0
        var sections = diffs.map { checkout, text in
            let body = text.trimmingCharacters(in: .newlines)
            let header = "===== BEGIN REPOPROMPT CHECKOUT DIFF: \(checkout.displayLabel) =====\n"
            let section = """
            \(header)\(body)
            ===== END REPOPROMPT CHECKOUT DIFF: \(checkout.displayLabel) =====
            """
            bodySpans.append(["offset": offset + header.utf8.count, "length": body.utf8.count])
            offset += section.utf8.count + "\n\n".utf8.count
            return section
        }

        if completeness == .partial || completeness == .failed {
            sections.append(incompleteDiagnostics(outcomes: outcomes, pathIssues: pathIssues))
        }

        return sections.isEmpty ? nil : sections.joined(separator: "\n\n")
    }

    private func incompleteDiagnostics(
        outcomes: [ReviewGitCheckoutOutcome],
        pathIssues: [ReviewGitPathIssue]
    ) -> String {
        var lines = ["===== REPOPROMPT REVIEW DIFF INCOMPLETE ====="]

        for issue in pathIssues {
            switch issue {
            case let .unresolvedSelection(displayPath):
                lines.append("- Selected path could not be resolved: \(displayPath)")
            case let .noRepository(displayPath):
                lines.append("- No owning repository: \(displayPath)")
            case let .unsupportedBackend(displayPath, backendKind):
                lines.append("- Unsupported repository backend (\(backendKind.rawValue)): \(displayPath)")
            case let .invalidGitLayout(displayPath):
                lines.append("- Invalid Git checkout layout: \(displayPath)")
            }
        }

        for outcome in outcomes {
            switch outcome {
            case let .baseResolutionFailed(checkout, _):
                lines.append("- Comparison base could not be resolved for checkout: \(checkout.displayLabel)")
            case let .commandFailed(checkout, _):
                lines.append("- Git diff command failed for checkout: \(checkout.displayLabel)")
            case .diff, .noChanges:
                break
            }
        }

        lines.append("===== END REPOPROMPT REVIEW DIFF INCOMPLETE =====")
        return lines.joined(separator: "\n")
    }
}
