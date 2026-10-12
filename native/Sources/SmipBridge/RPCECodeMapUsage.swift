import Foundation

enum CodeMapUsage: String, CaseIterable, Codable {
    case auto
    case complete
    /// Include code-map for selected files only (handled at injection sites;
    /// returning it here would duplicate).
    case selected
    case none
}
