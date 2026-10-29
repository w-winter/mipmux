import Foundation

/// The parent of a root-relative path, or the empty string for a top-level name. Linux Foundation traps when
/// `NSString.deletingLastPathComponent` receives a one-character path, so root-relative paths use this instead.
func relativeParent(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[..<slash])
}
