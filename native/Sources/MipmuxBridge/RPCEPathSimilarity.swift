// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable cyclomatic_complexity function_body_length identifier_name
import Foundation

/// Source PathMatcher lookup helpers share the executable module, not a public API.
extension PathMatcher {
    /// Fast ASCII-first probe: returns the lowercased ASCII byte of the first alphanumeric char, if any.
    /// Avoids per-scalar `String(...)`/`lowercased()` allocations in hot loops.
    @inline(__always)
    static func firstAlnumLowercasedByte(_ s: some StringProtocol) -> UInt8? {
        for b in s.utf8 {
            // '0'..'9' or 'A'..'Z' or 'a'..'z'
            if b >= 0x30, b <= 0x39 { return b }
            if b >= 0x41, b <= 0x5A { return b &+ 32 }
            if b >= 0x61, b <= 0x7A { return b }
            // skip anything else (e.g., '_' '-')
        }
        return nil
    }

    // MARK: - Heap-safe similarity (Swift-only, bounded Levenshtein)

    //
    // IMPORTANT: We intentionally do NOT use String.similarity(to:) here.
    // That API calls into C (repo_similarity_score / levenshtein / dice),
    // which is a potential source of heap corruption.
    //
    // This implementation is:
    // - bounded (banded DP) for speed
    // - case-policy aware (caseSensitive parameter)
    // - separator-fold aware (treat '-' and '_' as optional)

    /// Small cap so we don't allocate huge temporary buffers on the stack.
    /// Path components should be short; if not, we fall back to a cheap equality check.
    static let maxSimilarityByteLen = 256

    @inline(__always)
    static func appendStandardizedRelativePath(rootPath: String, relativePath: String) -> String {
        guard !relativePath.isEmpty else { return rootPath }
        return rootPath.hasSuffix("/") ? rootPath + relativePath : rootPath + "/" + relativePath
    }

    @inline(__always)
    static func containsParentTraversal(_ relativePath: String) -> Bool {
        relativePath == ".."
            || relativePath.hasPrefix("../")
            || relativePath.hasSuffix("/..")
            || relativePath.contains("/../")
    }

    @inline(__always)
    static func standardizedLookupPath(rootPath: String, relativePath: String) -> String {
        let normalizedRelativePath = StandardizedPath.relative(relativePath)
        let joinedPath = appendStandardizedRelativePath(rootPath: rootPath, relativePath: normalizedRelativePath)
        guard containsParentTraversal(normalizedRelativePath) else {
            return joinedPath
        }
        return StandardizedPath.absolute(joinedPath)
    }

    @inline(__always)
    static func similarityScoreMax(
        _ a: String,
        _ b: String,
        threshold: Double,
        caseSensitive: Bool
    ) -> Double {
        // Base + separator-folded (treat '-' and '_' as ignorable)
        let base = similarityScore(a, b, threshold: threshold, caseSensitive: caseSensitive, stripSeparators: false)
        let fold = similarityScore(a, b, threshold: threshold, caseSensitive: caseSensitive, stripSeparators: true)
        return max(base, fold)
    }

    @inline(__always)
    static func similarityScore(
        _ a: String,
        _ b: String,
        threshold: Double,
        caseSensitive: Bool,
        stripSeparators: Bool
    ) -> Double {
        if a.isEmpty && b.isEmpty { return 1.0 }
        if a.isEmpty || b.isEmpty { return 0.0 }

        // Clamp internally to avoid negative maxDist math when callers pass > 1.0
        let t = min(max(threshold, 0.0), 1.0)

        // Fast ASCII/UTF-8 byte path (no heap allocations; uses bounded DP)
        let aByteCount = a.utf8.count
        let bByteCount = b.utf8.count
        let maxByteCount = max(aByteCount, bByteCount)

        if maxByteCount <= maxSimilarityByteLen {
            // Stack temp buffers
            return withUnsafeTemporaryAllocation(of: UInt8.self, capacity: aByteCount) { aTmp in
                withUnsafeTemporaryAllocation(of: UInt8.self, capacity: bByteCount) { bTmp in
                    var aLen = 0
                    var bLen = 0

                    // Copy/lower/strip while validating ASCII (byte < 0x80)
                    for byte in a.utf8 {
                        if byte >= 0x80 { return unicodeSimilarityScore(
                            a,
                            b,
                            threshold: t,
                            caseSensitive: caseSensitive,
                            stripSeparators: stripSeparators
                        ) }
                        if stripSeparators && (byte == 0x2D || byte == 0x5F) { continue } // '-' or '_'
                        aTmp[aLen] = caseSensitive ? byte : PathCharPolicy.toLowerASCII(byte)
                        aLen += 1
                    }
                    for byte in b.utf8 {
                        if byte >= 0x80 { return unicodeSimilarityScore(
                            a,
                            b,
                            threshold: t,
                            caseSensitive: caseSensitive,
                            stripSeparators: stripSeparators
                        ) }
                        if stripSeparators && (byte == 0x2D || byte == 0x5F) { continue }
                        bTmp[bLen] = caseSensitive ? byte : PathCharPolicy.toLowerASCII(byte)
                        bLen += 1
                    }

                    let maxLen = max(aLen, bLen)
                    if maxLen == 0 { return 1.0 } // both became empty after stripping

                    // If threshold is 1.0, only exact matches can pass.
                    if t >= 1.0 {
                        if aLen != bLen { return 0.0 }
                        for i in 0 ..< aLen where aTmp[i] != bTmp[i] {
                            return 0.0
                        }
                        return 1.0
                    }

                    let maxDist = Int(ceil((1.0 - t) * Double(maxLen)))
                    let aBuf = UnsafeBufferPointer(start: aTmp.baseAddress, count: aLen)
                    let bBuf = UnsafeBufferPointer(start: bTmp.baseAddress, count: bLen)

                    let dist = levenshteinDistanceCapped(aBuf, bBuf, maxDist: maxDist)
                    if dist > maxDist { return 0.0 }
                    return 1.0 - Double(dist) / Double(maxLen)
                }
            }
        }

        // Too long: avoid expensive work; keep it deterministic and safe
        // (Path components shouldn't be this long; if they are, treat only exact equality as "similar".)
        return (caseSensitive ? (a == b) : (a.caseInsensitiveCompare(b) == .orderedSame)) ? 1.0 : 0.0
    }

    static func unicodeSimilarityScore(
        _ a: String,
        _ b: String,
        threshold: Double,
        caseSensitive: Bool,
        stripSeparators: Bool
    ) -> Double {
        let t = min(max(threshold, 0.0), 1.0)

        let a0 = caseSensitive ? a : a.lowercased()
        let b0 = caseSensitive ? b : b.lowercased()

        var aScalars: [UInt32] = []
        var bScalars: [UInt32] = []
        aScalars.reserveCapacity(a0.unicodeScalars.count)
        bScalars.reserveCapacity(b0.unicodeScalars.count)

        for sc in a0.unicodeScalars {
            if stripSeparators, sc.value == 0x2D || sc.value == 0x5F { continue }
            aScalars.append(sc.value)
        }
        for sc in b0.unicodeScalars {
            if stripSeparators, sc.value == 0x2D || sc.value == 0x5F { continue }
            bScalars.append(sc.value)
        }

        let maxLen = max(aScalars.count, bScalars.count)
        if maxLen == 0 { return 1.0 }
        if t >= 1.0 { return aScalars == bScalars ? 1.0 : 0.0 }

        // Keep it bounded
        let maxDist = Int(ceil((1.0 - t) * Double(maxLen)))
        return aScalars.withUnsafeBufferPointer { aBuf in
            bScalars.withUnsafeBufferPointer { bBuf in
                let dist = levenshteinDistanceCapped(aBuf, bBuf, maxDist: maxDist)
                if dist > maxDist { return 0.0 }
                return 1.0 - Double(dist) / Double(maxLen)
            }
        }
    }

    @inline(__always)
    static func levenshteinDistanceCapped<T: Equatable>(
        _ aIn: UnsafeBufferPointer<T>,
        _ bIn: UnsafeBufferPointer<T>,
        maxDist: Int
    ) -> Int {
        let big = maxDist + 1
        if maxDist < 0 { return big }

        var a = aIn
        var b = bIn

        if a.count == 0 { return b.count }
        if b.count == 0 { return a.count }

        // Ensure a is the shorter string
        if a.count > b.count {
            let tmp = a
            a = b
            b = tmp
        }

        let lenA = a.count
        let lenB = b.count

        if abs(lenA - lenB) > maxDist { return big }
        if maxDist == 0 {
            if lenA != lenB { return big }
            for i in 0 ..< lenA where a[i] != b[i] {
                return big
            }
            return 0
        }

        return withUnsafeTemporaryAllocation(of: Int.self, capacity: lenB + 1) { prev in
            withUnsafeTemporaryAllocation(of: Int.self, capacity: lenB + 1) { curr in
                // init to big
                for j in 0 ... lenB {
                    prev[j] = big
                    curr[j] = big
                }
                prev[0] = 0

                let hi0 = min(lenB, maxDist)
                if hi0 >= 1 {
                    for j in 1 ... hi0 {
                        prev[j] = j
                    }
                }

                for i in 1 ... lenA {
                    let jLo = max(1, i - maxDist)
                    let jHi = min(lenB, i + maxDist)

                    // reset curr
                    for j in 0 ... lenB {
                        curr[j] = big
                    }
                    if jLo == 1 { curr[0] = i }

                    var rowMin = big

                    for j in jLo ... jHi {
                        let ins = curr[j - 1] + 1
                        let del = prev[j] + 1
                        let sub = prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                        let v = min(ins, del, sub)
                        curr[j] = v
                        if v < rowMin { rowMin = v }
                    }

                    if rowMin > maxDist { return big }

                    // swap prev/curr
                    for j in 0 ... lenB {
                        prev[j] = curr[j]
                    }
                }

                let dist = prev[lenB]
                return dist > maxDist ? big : dist
            }
        }
    }
}

// swiftlint:enable cyclomatic_complexity function_body_length identifier_name
