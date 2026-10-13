// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: internal visibility; retain only Git pathspec normalization.
import Foundation

enum GitDiffPathNormalization {
    @inline(__always)
    static func normalizedAbsolutePath(_ path: String) -> String {
        StandardizedPath.absolute(path).precomposedStringWithCanonicalMapping
    }

    static func normalizedAbsolutePaths(_ paths: [String]) -> [String] {
        paths.map(normalizedAbsolutePath)
    }

    private struct NormalizedGitPathspec: Hashable {
        let plain: String
        let requiresLiteralMagic: Bool
    }

    static func gitPathspecs(from paths: [String], repoRootPath: String) -> [String] {
        var seen = Set<String>()
        return normalizedGitPathspecs(from: paths, repoRootPath: repoRootPath).compactMap { normalized in
            seen.insert(normalized.plain).inserted ? normalized.plain : nil
        }
    }

    /// Produces command pathspecs while preserving user-authored relative Git pathspec semantics.
    /// Absolute inputs are app/worktree-derived paths and must be literalized before invoking Git.
    static func gitDiscoveryPathspecs(from paths: [String], repoRootPath: String) -> [String] {
        var seen = Set<String>()
        return normalizedGitPathspecs(from: paths, repoRootPath: repoRootPath).compactMap { normalized in
            let pathspec = normalized.requiresLiteralMagic
                ? literalGitPathspec(normalized.plain)
                : normalized.plain
            return seen.insert(pathspec).inserted ? pathspec : nil
        }
    }

    static func literalGitPathspecs(_ paths: [String]) -> [String] {
        paths.map(literalGitPathspec)
    }

    private static func literalGitPathspec(_ path: String) -> String {
        ":(literal)\(path)"
    }

    private static func normalizedGitPathspecs(
        from paths: [String],
        repoRootPath: String
    ) -> [NormalizedGitPathspec] {
        let standardizedRoot = normalizedAbsolutePath(repoRootPath)
        var results: [NormalizedGitPathspec] = []
        results.reserveCapacity(paths.count)

        for rawPath in paths {
            let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !StandardizedPath.containsNUL(trimmed) else { continue }

            let expanded = (trimmed as NSString).expandingTildeInPath
            guard expanded.hasPrefix("/") else {
                results.append(NormalizedGitPathspec(plain: trimmed, requiresLiteralMagic: false))
                continue
            }

            let standardizedPath = normalizedAbsolutePath(expanded)
            guard StandardizedPath.isDescendant(standardizedPath, of: standardizedRoot) else {
                continue
            }
            if standardizedPath == standardizedRoot {
                results.append(NormalizedGitPathspec(plain: ".", requiresLiteralMagic: true))
                continue
            }

            let suffix: Substring = if standardizedRoot == "/" {
                standardizedPath.dropFirst()
            } else {
                standardizedPath.dropFirst(standardizedRoot.count)
            }
            let pathspec = StandardizedPath.relative(String(suffix))
            guard !pathspec.isEmpty else { continue }
            results.append(NormalizedGitPathspec(plain: pathspec, requiresLiteralMagic: true))
        }
        return results
    }
}
