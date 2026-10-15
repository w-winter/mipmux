import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

// Each wire variant has one dispatch branch; CCCC enforces the configured complexity limits.
// swiftlint:disable:next cyclomatic_complexity
private func execute(_ request: Request, files: ConfinedFiles, extraction: Extraction) async throws -> [String: Any] {
    switch request.operation {
    case .describe: try extraction.describe()
    case let .git(input): try input.render()
    case let .ignore(input): try await input.render(files: files)
    case let .sliceReadText(input): input.render()
    case let .renderFileBlock(input): input.render()
    case let .selection(input): try await input.render()
    case let .renderDiscoveryPrompt(input): input.render()
    case let .askUser(input): try input.render()
    case let .renderDiscoveryMessage(input): input.render()
    case let .renderFileTree(input): input.render()
    case let .renderPromptAssembly(input): input.render()
    case let .calculateTokenStats(input): try input.render()
    case let .prepareSearchPattern(input): input.render()
    case let .matchSearchPaths(input): try input.render()
    case let .scanLiteralLines(input): try input.render()
    case let .renderPreparedClipboard(input): try input.render()
    case let .renderClipboard(input): await input.render()
    case let .queryStructure(input): try input.render()
    case let .matchSelectionPath(input): input.render()
    case let .openRoots(roots): try files.openRoots(roots)
    case let .listDirectory(root, path): try files.list(root, path: path, request: request)
    case let .fingerprintGitDiff(input): try files.fingerprintGitDiff(input)
    case let .readSource(root, path, expected): try files.readSource(
            root,
            path: path,
            expected: expected,
            request: request,
            extraction: extraction
        )
    case let .extract(ext, bytes, expected): try extraction.extract(extension: ext, bytes: bytes, expected: expected)
    case let .beginExport(root, name): try files.beginExport(root, name: name)
    case let .beginGitSnapshot(root, repoKey, snapshotID):
        try files.beginGitSnapshot(root, repoKey: repoKey, snapshotID: snapshotID)
    case let .resolveGitSnapshotID(root, repoKey, snapshotID):
        try files.resolveGitSnapshotID(root, repoKey: repoKey, snapshotID: snapshotID)
    case let .readGitSnapshotCurrent(root, repoKey): try files.readGitSnapshotCurrent(root, repoKey: repoKey)
    case let .listGitSnapshots(root): try files.listGitSnapshots(root)
    case let .maintainGitSnapshots(input): try files.maintainGitSnapshots(input)
    case let .resolveGitSnapshotComparison(output, repository, compare):
        try files.resolveGitSnapshotComparison(output, repositoryHandle: repository, compare: compare)
    case let .writeGitSnapshotCurrent(run): try files.writeGitSnapshotCurrent(run)
    case let .readGitSnapshotFile(root, repoKey, snapshotID, path):
        try files.readGitSnapshotFile(root, repoKey: repoKey, snapshotID: snapshotID, path: path)
    case let .writeGitSnapshotFile(run, path, bytes): try files.writeGitSnapshotFile(run, path: path, bytes: bytes)
    case let .finishGitSnapshot(run): try files.finishGitSnapshot(run)
    case let .writeExport(run, filename, bytes): try files.writeExport(
            run,
            filename: filename,
            bytes: bytes,
            publish: false
        )
    case let .readExport(run, filename): try files.readExport(run, filename: filename)
    case let .publishManifest(run, bytes): try files.writeExport(
            run,
            filename: "manifest.json",
            bytes: bytes,
            publish: true
        )
    }
}

func serve() async throws {
    guard CommandLine.arguments.count == 2,
          !CommandLine.arguments[1].isEmpty else { throw BridgeFailure("missingGeneration") }
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
                let result = try await execute(request, files: files, extraction: extraction)
                try request.terminal(result)
            } catch let failure as BridgeFailure {
                try request.terminal([
                    "kind": "failure",
                    "code": failure.code,
                    "errno": failure.number.map { $0 as Any } ?? NSNull()
                ])
            } catch {
                try request.terminal(["kind": "failure", "code": "nativeOperationFailed", "errno": NSNull()])
            }
        }
    }
    guard pending.isEmpty else { throw BridgeFailure("truncatedFrame") }
}

do { try await serve() } catch {
    let code = (error as? BridgeFailure)?.code ?? "nativeWorkerFailed"
    let diagnostic = try? JSONSerialization.data(withJSONObject: ["level": "error", "code": code])
    if var diagnostic {
        diagnostic.append(0x0A)
        try? FileHandle.standardError.write(contentsOf: diagnostic)
    }
    exit(1)
}
