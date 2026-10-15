// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import Foundation
import RepoPromptRegexCore
#if canImport(Darwin)
    import os

    private typealias SearchRegexCacheLock = OSAllocatedUnfairLock<NSCache<NSString, PCRE2RegexBox>>
#else
    import Synchronization

    private typealias SearchRegexCacheLock = Mutex<NSCache<NSString, PCRE2RegexBox>>
#endif

private final class PCRE2RegexBox: NSObject {
    let regex: PCRE2Regex

    init(regex: PCRE2Regex) {
        self.regex = regex
    }
}

enum RPCESearchRegexCache {
    /// Only the lock owns the fresh cache; no NSCache reference leaves withLock.
    private static let pcre2Compiled = makeCache()

    private static func makeCache() -> SearchRegexCacheLock {
        let cache = NSCache<NSString, PCRE2RegexBox>()
        cache.countLimit = 256
        cache.totalCostLimit = 16 * 1024 * 1024
        #if canImport(Darwin)
            return SearchRegexCacheLock(uncheckedState: cache)
        #else
            return SearchRegexCacheLock(cache)
        #endif
    }

    static func pcre2Regex(for request: RepoPromptPCRE2CompileRequest) throws -> PCRE2Regex {
        try pcre2Compiled.withLock { cache in
            let key = (
                "\(request.pattern)|\(request.caseInsensitive)|" +
                    "\(request.multilineAnchors)|\(request.jitMode)"
            ) as NSString

            if let cached = cache.object(forKey: key) {
                return cached.regex
            }

            let regex = try RepoPromptPCRE2Adapter.compile(request)
            cache.setObject(
                PCRE2RegexBox(regex: regex),
                forKey: key,
                cost: estimatedCost(for: request)
            )
            return regex
        }
    }

    private static func estimatedCost(for request: RepoPromptPCRE2CompileRequest) -> Int {
        max(16 * 1024, request.pattern.utf8.count * 4)
    }
}
