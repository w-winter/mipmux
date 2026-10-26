// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 under Apache-2.0.
// Modified: apply the validated content read's binary probe to a confined descriptor, sampling with pread.
import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// RPCE's validated content read returns no content for a file whose first 8 KiB look binary.
enum RPCEBinaryProbe {
    private static let sampleBytes = 8192

    /// Whether the opened regular file at `path` is binary. Always-text names skip the probe, as in the source.
    static func isBinary(path: String, descriptor: Int32) throws -> Bool {
        if shouldSkipBinaryProbe(url: URL(fileURLWithPath: path)) { return false }
        var sample = [UInt8](repeating: 0, count: sampleBytes)
        let count = try sample.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { throw BridgeFailure("nativeProtocolError") }
            var filled = 0
            while filled < sampleBytes {
                let read = pread(descriptor, base + filled, sampleBytes - filled, off_t(filled))
                if read < 0, errno == EINTR { continue }
                guard read >= 0 else { throw ioFailure() }
                if read == 0 { break }
                filled += read
            }
            return filled
        }
        return isProbablyBinary(Data(sample.prefix(count)))
    }

    private static func shouldSkipBinaryProbe(url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return alwaysTextExtensions.contains(ext)
            || (ext.isEmpty && alwaysTextFilenames.contains(url.lastPathComponent.lowercased()))
    }

    private static func isProbablyBinary(_ data: Data, sampleSize: Int = 8192) -> Bool {
        guard !data.isEmpty else { return false }
        let sample = data.prefix(sampleSize)

        // Immediate NUL check
        if sample.contains(0) {
            return true
        }

        var ctrl = 0
        var printableOrUtf8 = 0

        for byte in sample {
            switch byte {
            case 0x09, 0x0A, 0x0D, 0x20 ... 0x7E: // HT, LF, CR, printable ASCII
                printableOrUtf8 += 1
            case 0x01 ... 0x08, 0x0B ... 0x0C, 0x0E ... 0x1F: // Other ASCII control chars
                ctrl += 1
            default: // 0x80–0xFF → UTF-8 part or extended ASCII
                printableOrUtf8 += 1
            }
        }

        let total = ctrl + printableOrUtf8
        guard total > 0 else { return false }
        return Double(ctrl) / Double(total) > 0.30
    }

    /// Extensions that are **always** treated as plain-text – we skip the binary probe entirely.
    private static let alwaysTextExtensions: Set<String> = [
        // ── General text / docs ─────────────────────────────────────
        "txt", "text", "md", "markdown", "rst", "mdx",
        // ── Data / config ───────────────────────────────────────────
        "json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
        "csv", "tsv", "proto",
        // ── Web assets ──────────────────────────────────────────────
        "html", "htm", "css", "scss", "sass", "less", "styl",
        "js", "mjs", "jsx", "ts", "tsx", "vue", "svelte", "astro", "pug", "jade",
        // ── Programming languages ──────────────────────────────────
        "swift", "c", "cpp", "cc", "h", "hpp", "m", "mm",
        "cs", "csx", // C-sharp
        "java", "kt", "kts", "groovy", "scala", "go", "rs", "dart", "zig", "nim",
        "py", "pyw", "pyx", "rb", "php", "phtml", "php5", "phps", "pl", "pm",
        "ex", "exs", "erl", "elixir", "clj", "cljs", "cljc", "coffee",
        "sh", "bash", "zsh", "fish", "cmd", "bat", "ps1", "psm1", "lua",
        "sql"
    ]

    /// Filenames with **no** extension that are always text.
    private static let alwaysTextFilenames: Set<String> = [
        "makefile", "dockerfile", "readme", "license",
        "gitignore", ".gitignore", ".ignore", ".env",
        ".gitattributes", ".editorconfig"
    ]
}
