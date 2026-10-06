import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

func serve() throws {
    guard CommandLine.arguments.count == 2, !CommandLine.arguments[1].isEmpty else { throw BridgeFailure("missingGeneration") }
    let generation = CommandLine.arguments[1]
    let extraction = try Extraction()
    let files = ConfinedFiles(generation: generation)
    var pending = Data()
    let inputChunkBytes = 64 * 1024
    var buffer = [UInt8](repeating: 0, count: inputChunkBytes)
    while true {
        let count = read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0, errno == EINTR { continue }
        guard count >= 0 else { throw BridgeFailure("nativeInputFailed", errno) }
        if count == 0 { break }
        pending.append(contentsOf: buffer.prefix(count))
        while let newline = pending.firstIndex(of: 0x0A) {
            let bytes = Data(pending[..<newline])
            pending.removeSubrange(...newline)
            let request = try Request(bytes, generation: generation)
            do {
                let result: [String: Any] = switch request.operation {
                case .describe: try extraction.describe()
                case let .openRoots(roots): try files.openRoots(roots)
                case let .listDirectory(root, path): try files.list(root, path: path, request: request)
                case let .readSource(root, path, expected): try files.readSource(root, path: path, expected: expected, request: request, extraction: extraction)
                case let .extract(ext, bytes, expected): try extraction.extract(extension: ext, bytes: bytes, expected: expected)
                case let .beginExport(root, name): try files.beginExport(root, name: name)
                case let .writeExport(run, filename, bytes): try files.writeExport(run, filename: filename, bytes: bytes, publish: false)
                case let .readExport(run, filename): try files.readExport(run, filename: filename)
                case let .publishManifest(run, bytes): try files.writeExport(run, filename: "manifest.json", bytes: bytes, publish: true)
                }
                try request.terminal(result)
            } catch let failure as BridgeFailure {
                try request.terminal(["kind": "failure", "code": failure.code, "errno": failure.number.map { $0 as Any } ?? NSNull()])
            } catch {
                try request.terminal(["kind": "failure", "code": "nativeOperationFailed", "errno": NSNull()])
            }
        }
    }
    guard pending.isEmpty else { throw BridgeFailure("truncatedFrame") }
}

do { try serve() } catch {
    let code = (error as? BridgeFailure)?.code ?? "nativeWorkerFailed"
    let diagnostic = try? JSONSerialization.data(withJSONObject: ["level": "error", "code": code])
    if var diagnostic {
        diagnostic.append(0x0A)
        try? FileHandle.standardError.write(contentsOf: diagnostic)
    }
    exit(1)
}
