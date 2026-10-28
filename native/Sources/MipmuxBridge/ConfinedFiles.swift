import Crypto
import Foundation
import RepoPromptCodeMapCore
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

final class Descriptor {
    let value: Int32
    private var closed = false
    init(_ value: Int32) throws {
        guard value >= 0 else { throw ioFailure() }
        self.value = value
    }

    func finish() throws {
        closed = true
        guard close(value) == 0 else { throw ioFailure() }
    }

    deinit { if !closed { close(value) } }
}

private struct Listed { let name: String; let kind: String; let fingerprint: DescriptorFingerprint }
private let listedKinds = [mode_t(S_IFREG): "file", mode_t(S_IFDIR): "directory", mode_t(S_IFLNK): "symlink"]

private struct Root {
    let directory: Descriptor
    let identity: RootIdentity
    let access: String
}

private struct ExportRun {
    let directory: Descriptor
    let root: Root
    let name: [String]
    let device: String
    let inode: String
}

private enum OutputRun {
    case bundle(ExportRun)
    case gitSnapshot(ExportRun)
}

final class ConfinedFiles {
    private let generation: String
    private var roots: [String: Root] = [:]
    private var runs: [String: OutputRun] = [:]
    private let gitMaintenance = RPCEGitSnapshotMaintenance()
    private let readChunkBytes = 64 * 1024
    init(generation: String) {
        self.generation = generation
    }

    func openRoots(_ declarations: [RootDeclaration]) throws -> [String: Any] {
        var prepared: [(String, Root, RootDeclaration)] = []
        var names = Set<String>()
        var paths = Set<Data>()
        for declaration in declarations {
            guard names.insert(declaration.name).inserted else { throw BridgeFailure("duplicateRoot") }
            let canonical = try canonicalPath(declaration.absolutePath)
            guard paths.insert(Data(canonical.utf8)).inserted else { throw BridgeFailure("duplicateRoot") }
            let directory = try openAbsoluteDirectory(canonical)
            let info = try status(directory.value)
            let identity = RootIdentity(declaredPath: declaration.absolutePath, canonicalPath: canonical,
                                        device: String(info.st_dev), inode: String(info.st_ino))
            if let expected = declaration.expected, expected != identity { throw BridgeFailure("rootChanged") }
            let root = Root(directory: directory, identity: identity, access: declaration.access)
            try validate(root)
            // After the fresh checks above, an admitted capability with the same byte-exact identity and
            // access kind is reused; the freshly opened descriptor is released instead of retained.
            if let admitted = roots.first(where: { $0.value.identity == identity && $0.value.access == declaration.access }) {
                prepared.append((admitted.key, admitted.value, declaration))
            } else {
                prepared.append((UUID().uuidString, root, declaration))
            }
        }
        var result: [[String: Any]] = []
        for (id, root, declaration) in prepared {
            roots[id] = root
            result.append(["handle": NativeHandle(generation: generation, id: id).json,
                           "name": declaration.name, "access": root.access, "identity": root.identity.json])
        }
        return ["kind": "rootsOpened", "roots": result]
    }

    func list(_ handle: NativeHandle, path: String?, request: Request,
              visit: (_ name: String, _ kind: String) -> Void = { _, _ in }) throws -> [String: Any] {
        let root = try sourceRoot(handle)
        let directory = try traverse(root.directory.value, components: path.map(components) ?? [])
        let before = try fingerprint(directory.value)
        let entries = try listedEntries(directory.value)
        var digest = SHA256()
        for entry in entries {
            digest.update(data: Data((entry.kind + "\0" + entry.name + "\0").utf8))
            visit(entry.name, entry.kind)
            try request.emit(["kind": "entry", "name": entry.name, "entryKind": entry.kind,
                              "fingerprint": entry.fingerprint.json])
        }
        guard try fingerprint(directory.value) == before else { throw BridgeFailure("sourceChanged") }
        try validate(root)
        let sha256 = digest.finalize().map { String(format: "%02x", $0) }.joined()
        return ["kind": "directoryComplete", "count": entries.count, "sha256": sha256]
    }

    /// The entries of a directory other than `.` and `..`, sorted by the bytes of their names.
    private func listedEntries(_ directory: Int32) throws -> [Listed] {
        let duplicate = dup(directory)
        guard duplicate >= 0 else { throw ioFailure() }
        guard let stream = fdopendir(duplicate) else { close(duplicate); throw ioFailure() }
        defer { closedir(stream) }
        var entries: [Listed] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw ioFailure() }
                break
            }
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) {
                    String(validatingCString: $0)
                }
            }
            guard let name else { throw BridgeFailure("invalidFilenameEncoding") }
            if [".", ".."].contains(name) { continue }
            var info = stat()
            guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            let kind = listedKinds[info.st_mode & mode_t(S_IFMT)] ?? "other"
            entries.append(Listed(name: name, kind: kind, fingerprint: DescriptorFingerprint(info)))
        }
        entries.sort { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
        return entries
    }

    func fingerprintGitDiff(_ input: GitFingerprintInput) throws -> [String: Any] {
        let root = try sourceRoot(input.root)
        let result = try input.render { path in
            var parts = try components(path)
            let leaf = parts.removeLast()
            let parent = try traverse(root.directory.value, components: parts)
            var info = stat()
            guard fstatat(parent.value, leaf, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            #if canImport(Darwin)
                let modified = info.st_mtimespec
            #else
                let modified = info.st_mtim
            #endif
            let time = Double(modified.tv_sec) + Double(modified.tv_nsec) / 1_000_000_000
            return [.size: NSNumber(value: Int64(info.st_size)), .modificationDate: Date(timeIntervalSince1970: time)]
        }
        try validate(root)
        return result
    }

    func inspectSource(_ handle: NativeHandle, path: String) throws -> [String: Any] {
        let root = try sourceRoot(handle)
        var parts = try components(path)
        let leaf = parts.removeLast()
        let parent = try traverse(root.directory.value, components: parts)
        var info = stat()
        guard fstatat(parent.value, leaf, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
        try validate(root)
        switch info.st_mode & mode_t(S_IFMT) {
        case mode_t(S_IFREG): return ["kind": "sourceInspected"]
        case mode_t(S_IFLNK): throw BridgeFailure("symlink")
        default: throw BridgeFailure("nonRegularFile")
        }
    }

    func readSource(_ handle: NativeHandle, path: String, expected: SourceIdentity?, request: Request, extraction: Extraction) throws -> [String: Any] {
        let emit: (Data) throws -> Void = { try request.emit(["kind": "bytes", "bytes": $0.base64EncodedString()]) }
        let read = try readConfinedSource(handle, path: path, expected: expected, skip: { _ in false }, chunk: emit)
        guard let read else { throw BridgeFailure("nativeProtocolError") }
        let ext = (path as NSString).pathExtension
        return try ["kind": "sourceComplete", "identity": read.identity.json, "fingerprint": read.fingerprint.json,
                    "decoding": RPCESourceDecoder.describe(RPCESourceDecoder.decode(read.content)),
                    "key": extraction.key(read.digest, byteCount: read.content.count, extension: ext)]
    }

    /// Reads a confined regular source that is unchanged across the read and equals `expected` when given. Returns nil
    /// when `skip` declines the opened descriptor; the same identity checks apply, but the contents are only hashed.
    func readConfinedSource(_ handle: NativeHandle, path: String, expected: SourceIdentity?,
                            skip: (Int32) throws -> Bool,
                            chunk: (Data) throws -> Void = { _ in }) throws -> ConfinedSource? {
        let root = try sourceRoot(handle)
        var parts = try components(path)
        let leaf = parts.removeLast()
        let parent = try traverse(root.directory.value, components: parts)
        let file = try Descriptor(openat(parent.value, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        let before = try fingerprint(file.value)
        guard try status(file.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw BridgeFailure("nonRegularFile") }
        let skipped = try skip(file.value)
        var digest = SHA256()
        var content = Data(), byteCount = 0
        try readChunks(file.value) { bytes in
            digest.update(data: bytes); byteCount += bytes.count
            if !skipped { content.append(bytes); try chunk(bytes) }
        }
        let rawDigest = CodeMapRawSourceDigest(bytes: Data(digest.finalize()))
        let identity = SourceIdentity(sha256: rawDigest.lowercaseHex, byteCount: byteCount)
        guard try fingerprint(file.value) == before else { throw BridgeFailure("sourceChanged") }
        if let expected, expected != identity { throw BridgeFailure("sourceChanged") }
        try validate(root)
        if skipped { return nil }
        return ConfinedSource(content: content, digest: rawDigest, identity: identity, fingerprint: before)
    }

    func captureIgnoreInputs(_ input: IgnoreCaptureInput) throws -> [String: Any] {
        let root = try sourceRoot(input.root)
        try validate(root)
        let loaded = URL(fileURLWithPath: root.identity.canonicalPath)
        let authority = try RPCEIgnoreAuthority.resolve(loaded)
        let repository: URL
        let repositoryPrefix: String
        let isGit: Bool
        switch authority {
        case .nonGit:
            repository = loaded
            repositoryPrefix = ""
            isGit = false
        case let .git(rootPrefix, layout):
            repository = layout.workTreeRoot
            repositoryPrefix = rootPrefix.value
            isGit = true
        }
        let authorityJSON = try describeIgnoreAuthority(authority)
        let directories: [(url: URL, relative: String)]
        if let relative = input.directory {
            _ = try traverse(root.directory.value, components: components(relative))
            let repositoryRelative = repositoryPrefix.isEmpty ? relative : repositoryPrefix + "/" + relative
            directories = [(loaded.appendingPathComponent(relative), repositoryRelative)]
        } else {
            directories = try ignoreAncestorDirectories(
                repository, prefix: repositoryPrefix, loaded: root.identity.canonicalPath
            )
        }
        var controls: [[String: Any]] = []
        for directory in directories {
            for name in [".gitignore", ".repo_ignore", ".cursorignore"] {
                if name == ".repo_ignore", !input.settings.respectRepoIgnore { continue }
                if name == ".cursorignore", !input.settings.respectCursorignore { continue }
                let path = directory.url.appendingPathComponent(name).path
                let content = try captureIgnoreControl(path, mandatory: isGit && name == ".gitignore", input: input)
                controls.append(["path": path, "directory": directory.relative, "name": name,
                                 "authority": name == ".gitignore" ? "mandatoryGit" : "secondary", "content": content])
            }
        }
        try validate(root)
        let currentAuthority = try describeIgnoreAuthority(RPCEIgnoreAuthority.resolve(loaded))
        guard NSDictionary(dictionary: currentAuthority).isEqual(to: authorityJSON) else {
            throw BridgeFailure("policyChanged")
        }
        return ["kind": "ignoreInputs", "authority": authorityJSON,
                "settings": input.settings.json, "controls": controls]
    }

    private func ignoreAncestorDirectories(
        _ repository: URL, prefix: String, loaded: String
    ) throws -> [(URL, String)] {
        var chain: [(URL, String)] = [(repository, "")]
        var current = repository
        var relative = ""
        for component in prefix.split(separator: "/") {
            current.appendPathComponent(String(component), isDirectory: true)
            relative = relative.isEmpty ? String(component) : relative + "/" + component
            chain.append((current, relative))
        }
        guard try canonicalPath(current.path) == loaded else { throw BridgeFailure("ambiguousGitTopology") }
        return chain
    }

    private func captureIgnoreControl(
        _ path: String, mandatory: Bool, input: IgnoreCaptureInput
    ) throws -> [String: Any] {
        do {
            return try readIgnoreControl(path, mandatory: mandatory, denied: input.deniedAbsolutePaths)
        } catch {
            let failure = error as? BridgeFailure
            let optional = input.directory != nil && !mandatory
                && failure != nil && failure?.code != "policyInputDenied"
            let record: [String: Any] = [
                "level": optional ? "warn" : "error", "event": "ignoreControlReadFailed",
                "path": path, "code": failure?.code ?? "nativeOperationFailed"
            ]
            try FileHandle.standardError.write(JSONSerialization.data(withJSONObject: record))
            FileHandle.standardError.write(Data([10]))
            guard optional, let failure else { throw error }
            return ["kind": "unavailable", "code": failure.code, "errno": failure.number ?? NSNull()]
        }
    }

    private func describeIgnoreAuthority(_ authority: RPCEIgnoreAuthority) throws -> [String: Any] {
        switch authority {
        case .nonGit:
            return ["kind": "nonGit"]
        case let .git(prefix, layout):
            return try [
                "kind": "git", "prefix": prefix.value,
                "repositoryRoot": directoryIdentity(layout.workTreeRoot.path).json,
                "gitDirectory": directoryIdentity(layout.gitDir.path).json,
                "commonDirectory": directoryIdentity(layout.commonDir.path).json
            ]
        }
    }

    private func directoryIdentity(_ path: String) throws -> RootIdentity {
        let canonical = try canonicalPath(path)
        let descriptor = try openAbsoluteDirectory(canonical)
        let info = try status(descriptor.value)
        return RootIdentity(declaredPath: path, canonicalPath: canonical,
                            device: String(info.st_dev), inode: String(info.st_ino))
    }

    private func readIgnoreControl(_ path: String, mandatory: Bool, denied: [String]) throws -> [String: Any] {
        func protected(_ value: String) -> Bool {
            if value.split(separator: "/").contains(where: { $0 == ".env" || $0.hasPrefix(".env.") }) { return true }
            return denied.contains { value == $0 || value.hasPrefix($0 == "/" ? "/" : $0 + "/") }
        }
        guard !protected(path) else { throw BridgeFailure("policyInputDenied") }
        var named = stat()
        if lstat(path, &named) != 0 {
            guard errno == ENOENT else { throw ioFailure() }
            return ["kind": "absent"]
        }
        let resolvedParent = try canonicalPath((path as NSString).deletingLastPathComponent)
        let resolved = mandatory
            ? (resolvedParent as NSString).appendingPathComponent((path as NSString).lastPathComponent)
            : try canonicalPath(path)
        guard !protected(resolved) else { throw BridgeFailure("policyInputDenied") }
        let parent = try openAbsoluteDirectory((resolved as NSString).deletingLastPathComponent)
        let descriptor = try Descriptor(openat(
            parent.value, (resolved as NSString).lastPathComponent, O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW
        ))
        let before = try fingerprint(descriptor.value)
        guard try status(descriptor.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else {
            throw BridgeFailure("nonRegularFile")
        }
        let mandatoryMaximumBytes = 4 * 1024 * 1024
        var data = Data()
        try readChunks(descriptor.value) { bytes in
            if mandatory, bytes.count > mandatoryMaximumBytes - data.count {
                throw BridgeFailure("ignoreControlTooLarge")
            }
            data.append(bytes)
        }
        var rebound = stat()
        guard try fingerprint(descriptor.value) == before,
              lstat(resolved, &rebound) == 0, String(rebound.st_dev) == before.device,
              String(rebound.st_ino) == before.inode else { throw BridgeFailure("sourceChanged") }
        guard let text = String(data: data, encoding: .utf8) else { throw BridgeFailure("decodeFailed") }
        return ["kind": "present", "resolvedPath": resolved, "identity": Extraction.identity(data).json, "text": text]
    }

    func beginExport(_ handle: NativeHandle, name: String) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output", try components(name).count == 1 else { throw BridgeFailure("invalidOutputCapability") }
        guard mkdirat(root.directory.value, name, 0o700) == 0 else { throw ioFailure() }
        let directory = try traverse(root.directory.value, components: [name])
        let info = try status(directory.value)
        let id = UUID().uuidString
        runs[id] = .bundle(ExportRun(directory: directory, root: root, name: [name],
                                     device: String(info.st_dev), inode: String(info.st_ino)))
        return ["kind": "exportOpened", "run": NativeHandle(generation: generation, id: id).json]
    }

    func writePromptExport(_ handle: NativeHandle, path: String, bytes: Data) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let parts = try components(path)
        let parent = try traverse(root.directory.value, components: Array(parts.dropLast()))
        try validate(root)
        try AtomicFile.create(parent.value, filename: parts.last!, bytes: bytes)
        try validate(root)
        let current = try traverse(root.directory.value, components: Array(parts.dropLast()))
        let previousInfo = try status(parent.value), currentInfo = try status(current.value)
        guard previousInfo.st_dev == currentInfo.st_dev, previousInfo.st_ino == currentInfo.st_ino else {
            throw BridgeFailure("outputChanged")
        }
        return ["kind": "promptExportWritten", "identity": Extraction.identity(bytes).json]
    }

    func resolveGitSnapshotID(_ handle: NativeHandle, repoKey: String, snapshotID: String?) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let repoParts = try snapshotRepoComponents(repoKey)
        let selected = try RPCEGitSnapshotNaming().resolveSnapshotID(override: snapshotID) { id in
            do {
                let repository = try traverse(root.directory.value, components: repoParts)
                return try self.snapshotExists(repository.value, id: id)
            } catch let failure as BridgeFailure where failure.code == "notFound" { return false }
        }
        guard let normalized = GitDiffSnapshotStore.normalizeSnapshotID(selected)
        else { throw BridgeFailure("invalidPath") }
        try validate(root)
        return ["kind": "gitSnapshotID", "snapshotID": normalized]
    }

    func beginGitSnapshot(_ handle: NativeHandle, repoKey: String, snapshotID: String?) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let repoParts = try snapshotRepoComponents(repoKey)
        let repository = try createDirectories(root.directory.value, components: repoParts)
        let selected = try RPCEGitSnapshotNaming().resolveSnapshotID(override: snapshotID) { id in
            try self.snapshotExists(repository.value, id: id)
        }
        guard let normalized = GitDiffSnapshotStore.normalizeSnapshotID(selected)
        else { throw BridgeFailure("invalidPath") }
        let idParts = try components(normalized), parts = repoParts + idParts
        let parent = try createDirectories(repository.value, components: Array(idParts.dropLast()))
        let leaf = parts[parts.count - 1]
        try removeSnapshotEntry(parent.value, name: leaf)
        guard mkdirat(parent.value, leaf, 0o700) == 0 else { throw ioFailure() }
        let directory = try traverse(parent.value, components: [leaf])
        let info = try status(directory.value)
        let id = UUID().uuidString
        let run = ExportRun(directory: directory, root: root, name: parts,
                            device: String(info.st_dev), inode: String(info.st_ino))
        try validate(run)
        runs[id] = .gitSnapshot(run)
        return ["kind": "gitSnapshotOpened", "run": NativeHandle(generation: generation, id: id).json,
                "relativePath": parts.joined(separator: "/"), "snapshotID": normalized]
    }

    func writeGitSnapshotCurrent(_ handle: NativeHandle) throws -> [String: Any] {
        let run = try lookupSnapshotRun(handle)
        return try writeCurrentSnapshot(run)
    }

    private func writeCurrentSnapshot(_ run: ExportRun) throws -> [String: Any] {
        let repository = try traverse(run.root.directory.value, components: Array(run.name.prefix(3)))
        let snapshotID = run.name.dropFirst(3).joined(separator: "/")
        var info = stat()
        if fstatat(repository.value, "CURRENT", &info, AT_SYMLINK_NOFOLLOW) == 0 {
            guard info.st_mode & mode_t(S_IFMT) != mode_t(S_IFDIR) else { throw BridgeFailure("nonRegularFile") }
            guard unlinkat(repository.value, "CURRENT", 0) == 0 else { throw ioFailure() }
        } else if errno != ENOENT { throw ioFailure() }
        let pointer: [String: Any]
        if symlinkat(snapshotID, repository.value, "CURRENT") != 0 {
            let failure = errno
            try AtomicFile.replace(repository.value, filename: "CURRENT", bytes: Data(snapshotID.utf8))
            pointer = ["kind": "file", "symlinkErrno": failure]
        } else {
            pointer = ["kind": "symlink"]
        }
        try validate(run)
        return ["kind": "gitSnapshotCurrentWritten", "snapshotID": snapshotID, "pointer": pointer]
    }

    func readGitSnapshotCurrent(_ handle: NativeHandle, repoKey: String) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let id = try currentSnapshotID(root, repoKey: repoKey)
        return ["kind": "gitSnapshotCurrent", "snapshotID": id as Any? ?? NSNull()]
    }

    func resolveGitSnapshotComparison(_ outputHandle: NativeHandle, repositoryHandle: NativeHandle,
                                      compare: String) throws -> [String: Any] {
        let output = try lookupRoot(outputHandle), repository = try sourceRoot(repositoryHandle)
        guard output.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let url = URL(fileURLWithPath: repository.identity.canonicalPath)
        let rootPath = (url.path as NSString).standardizingPath
        let repoKey = GitRepoDescriptor.makeRepoKey(for: rootPath, displayName: url.lastPathComponent)
        let result: [String: Any]
        do {
            let resolved = try RPCEGitSnapshotComparison().resolveCompareSpec(
                compare, displayName: url.lastPathComponent,
                currentID: { try self.currentSnapshotID(output, repoKey: repoKey) },
                manifest: { id in try self.readSnapshotManifest(output, repoKey: repoKey, id: id) }
            )
            result = try [
                "kind": "gitSnapshotComparison",
                "comparison": decodeWireJSON(JSONEncoder().encode(resolved.spec)),
                "resolved": resolved.resolved,
                "input": resolved.input as Any? ?? NSNull()
            ]
        } catch let failure as RPCEGitSnapshotComparison.Failure {
            result = ["kind": "gitSnapshotComparisonError", "code": failure.code, "message": failure.message]
        }
        try validate(repository)
        try validate(output)
        return result
    }

    private func readSnapshotManifest(_ root: Root, repoKey: String, id: String) throws -> GitDiffSnapshotManifest? {
        guard let normalized = GitDiffSnapshotStore.normalizeSnapshotID(id) else { throw BridgeFailure("invalidPath") }
        let parts = try snapshotRepoComponents(repoKey) + components(normalized)
        let parent = try traverse(root.directory.value, components: parts)
        let bytes = try readSnapshotBytes(parent.value, name: "manifest.json")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(GitDiffSnapshotManifest.self, from: bytes)
    }

    private func currentSnapshotID(_ root: Root, repoKey: String) throws -> String? {
        let repoParts = try snapshotRepoComponents(repoKey)
        let pointer: CapturedGitSnapshotPointer
        do {
            let repository = try traverse(root.directory.value, components: repoParts)
            pointer = try readSnapshotPointer(repository.value)
            let repoPath = URL(fileURLWithPath: root.identity.canonicalPath)
                .appendingPathComponent(repoParts.joined(separator: "/")).path
            if let raw = RPCEGitSnapshotPointer().readCurrentPointer(pointer, relativeTo: repoPath) {
                guard let normalized = GitDiffSnapshotStore.normalizeSnapshotID(raw) else {
                    throw BridgeFailure("invalidPath")
                }
                let exists: Bool
                if case .symlink = pointer {
                    exists = try snapshotExists(repository.value, id: normalized)
                } else {
                    exists = true
                }
                try validate(root)
                return exists ? normalized : nil
            }
        } catch let failure as BridgeFailure where failure.code == "notFound" {
            try validate(root)
        }
        try validate(root)
        return nil
    }

    func readGitSnapshotFile(
        _ handle: NativeHandle, repoKey: String, snapshotID: String, path: String
    ) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output", let normalized = GitDiffSnapshotStore.normalizeSnapshotID(snapshotID) else {
            throw BridgeFailure("invalidOutputCapability")
        }
        let parts = try snapshotRepoComponents(repoKey) + components(normalized) + components(path)
        let parent = try traverse(root.directory.value, components: Array(parts.dropLast()))
        let before = try status(parent.value)
        let bytes = try readSnapshotBytes(parent.value, name: parts[parts.count - 1])
        let current = try traverse(root.directory.value, components: Array(parts.dropLast()))
        let after = try status(current.value)
        guard before.st_dev == after.st_dev, before.st_ino == after.st_ino else { throw BridgeFailure("outputChanged") }
        try validate(root)
        return [
            "kind": "gitSnapshotRead",
            "bytes": bytes.base64EncodedString(),
            "identity": Extraction.identity(bytes).json
        ]
    }

    func writeGitSnapshotFile(_ handle: NativeHandle, path: String, bytes: Data) throws -> [String: Any] {
        let run = try lookupSnapshotRun(handle)
        let parts = try components(path), directories = Array(parts.dropLast()), leaf = parts[parts.count - 1]
        let parent = try createDirectories(run.directory.value, components: directories)
        try AtomicFile.replace(parent.value, filename: leaf, bytes: bytes)
        try validate(run)
        let current = try traverse(run.directory.value, components: directories)
        let previousInfo = try status(parent.value), currentInfo = try status(current.value)
        guard previousInfo.st_dev == currentInfo.st_dev, previousInfo.st_ino == currentInfo.st_ino else {
            throw BridgeFailure("outputChanged")
        }
        return ["kind": "gitSnapshotFileWritten", "identity": Extraction.identity(bytes).json]
    }

    func finishGitSnapshot(_ handle: NativeHandle) throws -> [String: Any] {
        guard handle.generation == generation,
              let owned = runs[handle.id],
              case let .gitSnapshot(run) = owned
        else { throw BridgeFailure("invalidExportHandle") }
        runs.removeValue(forKey: handle.id)
        try run.directory.finish()
        return ["kind": "gitSnapshotFinished"]
    }

    func writeExport(_ handle: NativeHandle, filename: String, bytes: Data, publish: Bool) throws -> [String: Any] {
        let run = try lookupRun(handle)
        let file = try Descriptor(openat(run.directory.value, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        do {
            try AtomicFile.writeBytes(bytes, descriptor: file.value)
            guard fsync(file.value) == 0 else { throw ioFailure() }
            try file.finish()
            try validate(run)
            if publish {
                guard fsync(run.directory.value) == 0, fsync(run.root.directory.value) == 0 else { throw ioFailure() }
            }
        } catch {
            if publish { throw BridgeFailure("publicationUncertain", (error as? BridgeFailure)?.number) }
            throw error
        }
        return ["kind": publish ? "manifestPublished" : "exportWritten", "identity": Extraction.identity(bytes).json]
    }

    func readExport(_ handle: NativeHandle, filename: String) throws -> [String: Any] {
        let run = try lookupRun(handle)
        let file = try Descriptor(openat(run.directory.value, filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        guard try status(file.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        else { throw BridgeFailure("nonRegularFile") }
        let before = try fingerprint(file.value)
        var bytes = Data()
        try readChunks(file.value) { bytes.append($0) }
        guard try fingerprint(file.value) == before else { throw BridgeFailure("sourceChanged") }
        try validate(run)
        return ["kind": "exportRead", "bytes": bytes.base64EncodedString(), "identity": Extraction.identity(bytes).json]
    }

    func listGitSnapshots(_ handle: NativeHandle) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let rows = try maintenanceSnapshots(root)
        try validate(root)
        let formatter = ISO8601DateFormatter()
        return ["kind": "gitSnapshots", "snapshots": rows.map {
            ["repoKey": $0.repoKey, "snapshotID": $0.snapshotID,
             "generatedAt": formatter.string(from: $0.manifest.generatedAt)]
        }]
    }

    func maintainGitSnapshots(_ input: GitSnapshotMaintenanceInput) throws -> [String: Any] {
        let root = try lookupRoot(input.root)
        guard root.access == "output" else { throw BridgeFailure("invalidOutputCapability") }
        let storage = GitSnapshotMaintenanceIO(
            snapshots: { try self.maintenanceSnapshots(root) },
            delete: { key, id in try self.deleteMaintenanceSnapshot(root, repoKey: key, id: id) },
            updateCurrent: { key in try self.updateMaintenanceCurrent(root, repoKey: key) },
            cleanup: { keys in try self.cleanupMaintenanceDirectories(root, keys: keys) },
            read: { name in
                do {
                    let directory = try traverse(root.directory.value, components: ["_git_data"])
                    return try self.readSnapshotBytes(directory.value, name: name.rawValue)
                } catch let failure as BridgeFailure where failure.code == "notFound" { return nil }
            },
            write: { name, bytes in
                try self.validate(root)
                let directory = try traverse(root.directory.value, components: ["_git_data"])
                try AtomicFile.replace(directory.value, filename: name.rawValue, bytes: bytes)
            },
            remove: { name in
                try self.validate(root)
                let directory = try traverse(root.directory.value, components: ["_git_data"])
                if unlinkat(directory.value, name.rawValue, 0) != 0, errno != ENOENT { throw ioFailure() }
            }
        )
        let outcome = try gitMaintenance.run(input.action, workspace: root.identity.canonicalPath, storage: storage)
        try validate(root)
        return ["kind": "gitSnapshotsMaintained", "outcome": outcome]
    }

    private func maintenanceSnapshots(_ root: Root) throws -> [GitMaintenanceSnapshot] {
        let repos: Descriptor
        do {
            repos = try traverse(root.directory.value, components: ["_git_data", "repos"])
        } catch let failure as BridgeFailure where failure.code == "notFound" {
            return []
        }
        var result: [GitMaintenanceSnapshot] = []
        for key in try directoryNames(repos.value) where !key.hasPrefix(".") && key != "CURRENT" {
            var info = stat()
            guard fstatat(repos.value, key, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else { continue }
            let directory = try traverse(repos.value, components: [key])
            let snapshots = try? scanMaintenanceSnapshots(directory.value, root: root, repoKey: key, parts: [])
            result.append(contentsOf: snapshots ?? [])
        }
        return result
    }

    private func scanMaintenanceSnapshots(
        _ directory: Int32, root: Root, repoKey: String, parts: [String]
    ) throws -> [GitMaintenanceSnapshot] {
        var result: [GitMaintenanceSnapshot] = []
        for name in try directoryNames(directory)
            where !name.hasPrefix(".") && name != "CURRENT" && name != "diff-snapshots" {
            var info = stat()
            guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
                let path = ["_git_data", "repos", repoKey] + parts + [name]
                let url = URL(fileURLWithPath: root.identity.canonicalPath)
                    .appendingPathComponent(path.joined(separator: "/"))
                if (try? url.resourceValues(forKeys: [.isPackageKey]).isPackage) == true { continue }
                let child = try traverse(directory, components: [name])
                result += try scanMaintenanceSnapshots(child.value, root: root, repoKey: repoKey, parts: parts + [name])
            } else if name == "manifest.json", info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
                      let manifest = try? readSnapshotManifest(
                          root,
                          repoKey: repoKey,
                          id: parts.joined(separator: "/")
                      ) {
                result.append(GitMaintenanceSnapshot(
                    repoKey: repoKey,
                    snapshotID: parts.joined(separator: "/"),
                    manifest: manifest
                ))
            }
        }
        return result
    }

    private func deleteMaintenanceSnapshot(_ root: Root, repoKey: String, id: String) throws -> Bool {
        try validate(root)
        guard let normalized = GitDiffSnapshotStore.normalizeSnapshotID(id) else { throw BridgeFailure("invalidPath") }
        let repository = try traverse(root.directory.value, components: snapshotRepoComponents(repoKey))
        guard try snapshotExists(repository.value, id: normalized) else { return false }
        let parts = try components(normalized)
        let parent = try traverse(repository.value, components: Array(parts.dropLast()))
        try removeSnapshotEntry(parent.value, name: parts[parts.count - 1])
        var ancestors = Array(parts.dropLast())
        while !ancestors.isEmpty {
            let current = try traverse(repository.value, components: ancestors)
            guard try directoryNames(current.value).allSatisfy({ $0.hasPrefix(".") }) else { break }
            let container = try traverse(repository.value, components: Array(ancestors.dropLast()))
            try removeSnapshotEntry(container.value, name: ancestors.removeLast())
        }
        return true
    }

    private func updateMaintenanceCurrent(_ root: Root, repoKey: String) throws {
        let newest = try maintenanceSnapshots(root).filter { $0.repoKey == repoKey }
            .sorted { $0.manifest.generatedAt > $1.manifest.generatedAt }.first
        guard let newest else {
            let repository = try traverse(root.directory.value, components: snapshotRepoComponents(repoKey))
            let pointer = try readSnapshotPointer(repository.value)
            let exists: Bool
            switch pointer {
            case .file: exists = true
            case .symlink: exists = try currentSnapshotID(root, repoKey: repoKey) != nil
            case .missing: exists = false
            }
            if exists, unlinkat(repository.value, "CURRENT", 0) != 0 { throw ioFailure() }
            return
        }
        let parts = try snapshotRepoComponents(repoKey) + components(newest.snapshotID)
        let directory = try traverse(root.directory.value, components: parts)
        let info = try status(directory.value)
        _ = try writeCurrentSnapshot(ExportRun(directory: directory, root: root, name: parts,
                                               device: String(info.st_dev), inode: String(info.st_ino)))
    }

    private func cleanupMaintenanceDirectories(_ root: Root, keys: Set<String>) throws {
        try validate(root)
        let repos = try traverse(root.directory.value, components: ["_git_data", "repos"])
        for key in keys {
            let directory = try traverse(repos.value, components: [key])
            if try directoryNames(directory.value).allSatisfy({ $0.hasPrefix(".") }) {
                try removeSnapshotEntry(repos.value, name: key)
            }
        }
        if try directoryNames(repos.value).allSatisfy({ $0.hasPrefix(".") }) {
            let gitData = try traverse(root.directory.value, components: ["_git_data"])
            try removeSnapshotEntry(gitData.value, name: "repos")
        }
    }

    private func directoryNames(_ directory: Int32) throws -> [String] {
        let copy = try traverse(directory, components: [])
        let duplicate = dup(copy.value)
        guard duplicate >= 0 else { throw ioFailure() }
        guard let stream = fdopendir(duplicate) else { close(duplicate); throw ioFailure() }
        defer { closedir(stream) }
        var result: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw ioFailure() }
                break
            }
            let name = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) {
                    String(validatingCString: $0)
                }
            }
            guard let name else { throw BridgeFailure("invalidFilenameEncoding") }
            if name != ".", name != ".." { result.append(name) }
        }
        return result
    }

    private func snapshotRepoComponents(_ repoKey: String) throws -> [String] {
        guard try components(repoKey).count == 1 else { throw BridgeFailure("invalidPath") }
        return ["_git_data", "repos", repoKey]
    }

    private func snapshotExists(_ repository: Int32, id: String) throws -> Bool {
        do {
            let parts = try components(id)
            let parent = try traverse(repository, components: Array(parts.dropLast()))
            var info = stat()
            if fstatat(parent.value, parts[parts.count - 1], &info, AT_SYMLINK_NOFOLLOW) == 0 { return true }
            if errno == ENOENT { return false }
            throw ioFailure()
        } catch let failure as BridgeFailure where failure.code == "notFound" { return false }
    }

    private func readSnapshotPointer(_ repository: Int32) throws -> CapturedGitSnapshotPointer {
        var info = stat()
        guard fstatat(repository, "CURRENT", &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
        if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFLNK) {
            var bytes = [UInt8](repeating: 0, count: Int(info.st_size) + 1)
            let count = readlinkat(repository, "CURRENT", &bytes, bytes.count)
            guard count >= 0 else { throw ioFailure() }
            guard count < bytes.count else { throw BridgeFailure("outputChanged") }
            guard let text = String(data: Data(bytes.prefix(count)), encoding: .utf8) else { return .missing }
            return .symlink(text)
        }
        return try .file(readSnapshotBytes(repository, name: "CURRENT"))
    }

    private func readSnapshotBytes(_ parent: Int32, name: String) throws -> Data {
        let file = try Descriptor(openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        guard try status(file.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG)
        else { throw BridgeFailure("nonRegularFile") }
        let before = try fingerprint(file.value)
        var bytes = Data()
        try readChunks(file.value) { bytes.append($0) }
        guard try fingerprint(file.value) == before else { throw BridgeFailure("sourceChanged") }
        return bytes
    }

    private func removeSnapshotEntry(_ parent: Int32, name: String) throws {
        var info = stat()
        if fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            if errno == ENOENT { return }
            throw ioFailure()
        }
        guard info.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK) else { throw BridgeFailure("symlink") }
        if info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) {
            let directory = try traverse(parent, components: [name])
            try removeSnapshotContents(directory.value)
            var current = stat()
            guard fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            guard current.st_dev == info.st_dev,
                  current.st_ino == info.st_ino else { throw BridgeFailure("outputChanged") }
            guard unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw ioFailure() }
        } else {
            guard unlinkat(parent, name, 0) == 0 else { throw ioFailure() }
        }
    }

    private func removeSnapshotContents(_ directory: Int32) throws {
        let duplicate = dup(directory)
        guard duplicate >= 0 else { throw ioFailure() }
        guard let stream = fdopendir(duplicate) else { close(duplicate); throw ioFailure() }
        defer { closedir(stream) }
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw ioFailure() }
                break
            }
            let child = withUnsafePointer(to: entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: entry.pointee.d_name)) {
                    String(validatingCString: $0)
                }
            }
            guard let child else { throw BridgeFailure("invalidFilenameEncoding") }
            if child == "." || child == ".." { continue }
            try removeSnapshotEntry(directory, name: child)
        }
    }

    private func readChunks(_ fd: Int32, body: (Data) throws -> Void) throws {
        var buffer = [UInt8](repeating: 0, count: readChunkBytes)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count < 0, errno == EINTR { continue }
            guard count >= 0 else { throw ioFailure() }
            if count == 0 { return }
            try body(Data(buffer.prefix(count)))
        }
    }

    private func lookupRoot(_ handle: NativeHandle) throws -> Root {
        guard handle.generation == generation, let root = roots[handle.id] else { throw BridgeFailure("invalidRootHandle") }
        try validate(root)
        return root
    }

    private func sourceRoot(_ handle: NativeHandle) throws -> Root {
        let root = try lookupRoot(handle)
        guard root.access == "source" else { throw BridgeFailure("invalidSourceCapability") }
        return root
    }

    private func lookupSnapshotRun(_ handle: NativeHandle) throws -> ExportRun {
        guard handle.generation == generation, case let .gitSnapshot(run) = runs[handle.id] else {
            throw BridgeFailure("invalidExportHandle")
        }
        try validate(run)
        return run
    }

    private func lookupRun(_ handle: NativeHandle) throws -> ExportRun {
        guard handle.generation == generation, case let .bundle(run) = runs[handle.id] else {
            throw BridgeFailure("invalidExportHandle")
        }
        try validate(run)
        return run
    }

    private func validate(_ root: Root) throws {
        do {
            guard try Data(canonicalPath(root.identity.declaredPath).utf8) == Data(root.identity.canonicalPath.utf8) else { throw BridgeFailure("rootChanged") }
            let reopened = try openAbsoluteDirectory(root.identity.canonicalPath)
            let info = try status(reopened.value)
            guard String(info.st_dev) == root.identity.device, String(info.st_ino) == root.identity.inode else { throw BridgeFailure("rootChanged") }
        } catch let failure as BridgeFailure where ["notFound", "nonRegularFile", "symlink"].contains(failure.code) {
            throw BridgeFailure("rootChanged")
        }
    }

    private func validate(_ run: ExportRun) throws {
        try validate(run.root)
        let reopened = try traverse(run.root.directory.value, components: run.name)
        let info = try status(reopened.value)
        guard String(info.st_dev) == run.device, String(info.st_ino) == run.inode else { throw BridgeFailure("outputChanged") }
    }
}

private func canonicalPath(_ path: String) throws -> String {
    guard let resolved = realpath(path, nil) else { throw ioFailure() }
    defer { free(resolved) }
    guard let result = String(validatingCString: resolved) else { throw BridgeFailure("invalidFilenameEncoding") }
    return result
}

private func components(_ path: String) throws -> [String] {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.utf8.contains(0) }) else { throw BridgeFailure("invalidPath") }
    return parts
}

private func traverse(_ root: Int32, components: [String]) throws -> Descriptor {
    // A fresh open avoids sharing directory offsets and overlayfs enumeration caches.
    var current = try Descriptor(openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    for part in components {
        current = try Descriptor(openat(current.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    }
    return current
}

private func createDirectories(_ root: Int32, components: [String]) throws -> Descriptor {
    var current = try Descriptor(openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    for part in components {
        if mkdirat(current.value, part, 0o700) != 0, errno != EEXIST { throw ioFailure() }
        current = try Descriptor(openat(current.value, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC))
    }
    return current
}

private func openAbsoluteDirectory(_ path: String) throws -> Descriptor {
    let root = try Descriptor(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
    return try traverse(root.value, components: path == "/" ? [] : components(String(path.dropFirst())))
}

private func status(_ fd: Int32) throws -> stat {
    var result = stat()
    guard fstat(fd, &result) == 0 else { throw ioFailure() }
    return result
}

struct DescriptorFingerprint: Equatable {
    let device: String
    let inode: String
    let size: Int64
    let mode: UInt32
    let modifiedSeconds: String
    let modifiedNanoseconds: Int
    let changedSeconds: String
    let changedNanoseconds: Int

    init(_ info: stat) {
        #if canImport(Darwin)
            let modified = info.st_mtimespec, changed = info.st_ctimespec
        #else
            let modified = info.st_mtim, changed = info.st_ctim
        #endif
        device = String(info.st_dev); inode = String(info.st_ino)
        size = Int64(info.st_size); mode = UInt32(info.st_mode)
        modifiedSeconds = String(modified.tv_sec); modifiedNanoseconds = Int(modified.tv_nsec)
        changedSeconds = String(changed.tv_sec); changedNanoseconds = Int(changed.tv_nsec)
    }

    var json: [String: Any] {
        ["device": device, "inode": inode, "size": size, "mode": mode,
         "modifiedSeconds": modifiedSeconds, "modifiedNanoseconds": modifiedNanoseconds,
         "changedSeconds": changedSeconds, "changedNanoseconds": changedNanoseconds]
    }
}

private func fingerprint(_ fd: Int32) throws -> DescriptorFingerprint {
    try DescriptorFingerprint(status(fd))
}

func ioFailure() -> BridgeFailure {
    let number = errno
    let code = switch number {
    case ENOENT: "notFound"
    case EACCES, EPERM: "permissionDenied"
    case ELOOP: "symlink"
    case EEXIST: "alreadyExists"
    case ENOTDIR: "nonRegularFile"
    default: "nativeIOFailed"
    }
    return BridgeFailure(code, number)
}
