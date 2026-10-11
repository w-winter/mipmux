// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: internal visibility; retain parsing and canonical encoding only.
import Foundation

enum GitDiffCompareSpec: Sendable, Equatable, Encodable {
    case uncommitted(base: String)
    case uncommittedMergeBase(base: String)
    case staged(base: String)
    case stagedMergeBase(base: String)
    case unstaged
    case revspec(String)

    private enum Kind: String, Codable {
        case uncommitted
        case uncommittedMergeBase
        case staged
        case stagedMergeBase
        case unstaged
        case revspec
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case base
        case spec
    }

    // Source parsing branches remain intact; CCCC checks remain enabled.
    // swiftlint:disable:next cyclomatic_complexity
    static func parse(_ raw: String?) -> GitDiffCompareSpec {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .uncommitted(base: "HEAD")
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()

        if lowered == "uncommitted" {
            return .uncommitted(base: "HEAD")
        }
        if lowered.hasPrefix("uncommitted:") {
            let baseRaw = trimmed.dropFirst("uncommitted:".count)
            let base = baseRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            return .uncommitted(base: base.isEmpty ? "HEAD" : base)
        }
        if lowered.hasPrefix("mergebase:") {
            let baseRaw = trimmed.dropFirst("mergebase:".count)
            let base = baseRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            return .uncommittedMergeBase(base: base.isEmpty ? "HEAD" : base)
        }
        if lowered.hasPrefix("uncommitted-mergebase:") {
            let baseRaw = trimmed.dropFirst("uncommitted-mergebase:".count)
            let base = baseRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            return .uncommittedMergeBase(base: base.isEmpty ? "HEAD" : base)
        }
        if lowered == "staged" {
            return .staged(base: "HEAD")
        }
        if lowered.hasPrefix("staged:") {
            let baseRaw = trimmed.dropFirst("staged:".count)
            let base = baseRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            return .staged(base: base.isEmpty ? "HEAD" : base)
        }
        if lowered.hasPrefix("staged-mergebase:") {
            let baseRaw = trimmed.dropFirst("staged-mergebase:".count)
            let base = baseRaw.trimmingCharacters(in: .whitespacesAndNewlines)
            return .stagedMergeBase(base: base.isEmpty ? "HEAD" : base)
        }
        if lowered == "unstaged" {
            return .unstaged
        }
        if lowered.hasPrefix("back:") {
            let countRaw = trimmed.dropFirst("back:".count)
            let count = Int(countRaw.trimmingCharacters(in: .whitespacesAndNewlines))
            if let count, count > 0 {
                return .revspec("HEAD~\(count)..HEAD")
            }
        }

        return .revspec(trimmed)
    }

    var rawKey: String {
        switch self {
        case let .uncommitted(base):
            "uncommitted:\(base)"
        case let .uncommittedMergeBase(base):
            "uncommitted-mergebase:\(base)"
        case let .staged(base):
            "staged:\(base)"
        case let .stagedMergeBase(base):
            "staged-mergebase:\(base)"
        case .unstaged:
            "unstaged"
        case let .revspec(spec):
            "revspec:\(spec)"
        }
    }

    var displayString: String {
        switch self {
        case let .uncommitted(base):
            base == "HEAD" ? "uncommitted" : "uncommitted:\(base)"
        case let .uncommittedMergeBase(base):
            "mergebase:\(base)"
        case let .staged(base):
            base == "HEAD" ? "staged" : "staged:\(base)"
        case let .stagedMergeBase(base):
            "staged-mergebase:\(base)"
        case .unstaged:
            "unstaged"
        case let .revspec(spec):
            spec
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .uncommitted(base):
            try container.encode(Kind.uncommitted, forKey: .kind)
            try container.encode(base, forKey: .base)
        case let .uncommittedMergeBase(base):
            try container.encode(Kind.uncommittedMergeBase, forKey: .kind)
            try container.encode(base, forKey: .base)
        case let .staged(base):
            try container.encode(Kind.staged, forKey: .kind)
            try container.encode(base, forKey: .base)
        case let .stagedMergeBase(base):
            try container.encode(Kind.stagedMergeBase, forKey: .kind)
            try container.encode(base, forKey: .base)
        case .unstaged:
            try container.encode(Kind.unstaged, forKey: .kind)
        case let .revspec(spec):
            try container.encode(Kind.revspec, forKey: .kind)
            try container.encode(spec, forKey: .spec)
        }
    }
}
