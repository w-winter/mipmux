import Crypto
import Foundation
import RepoPromptCodeMapCore
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

private final class Descriptor {
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

private struct Root {
    let directory: Descriptor
    let identity: RootIdentity
    let access: String
}

private struct ExportRun {
    let directory: Descriptor
    let root: Root
    let name: String
    let device: String
    let inode: String
}

final class ConfinedFiles {
    private let generation: String
    private var roots: [String: Root] = [:]
    private var runs: [String: ExportRun] = [:]
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

    func list(_ handle: NativeHandle, path: String?, request: Request) throws -> [String: Any] {
        let root = try sourceRoot(handle)
        let directory = try traverse(root.directory.value, components: path.map(components) ?? [])
        let before = try fingerprint(directory.value)
        let duplicate = dup(directory.value)
        guard duplicate >= 0 else { throw ioFailure() }
        guard let stream = fdopendir(duplicate) else { close(duplicate); throw ioFailure() }
        defer { closedir(stream) }
        var entries: [(String, String)] = []
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
            if name == "." || name == ".." { continue }
            var info = stat()
            guard fstatat(directory.value, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { throw ioFailure() }
            let kind = switch info.st_mode & mode_t(S_IFMT) {
            case mode_t(S_IFREG): "file"
            case mode_t(S_IFDIR): "directory"
            case mode_t(S_IFLNK): "symlink"
            default: "other"
            }
            entries.append((name, kind))
        }
        entries.sort { Array($0.0.utf8).lexicographicallyPrecedes(Array($1.0.utf8)) }
        var digest = SHA256()
        for (name, kind) in entries {
            digest.update(data: Data((kind + "\0" + name + "\0").utf8))
            try request.emit(["kind": "entry", "name": name, "entryKind": kind])
        }
        guard try fingerprint(directory.value) == before else { throw BridgeFailure("sourceChanged") }
        try validate(root)
        return ["kind": "directoryComplete", "count": entries.count, "sha256": digest.finalize().map { String(format: "%02x", $0) }.joined()]
    }

    func readSource(_ handle: NativeHandle, path: String, expected: SourceIdentity?, request: Request, extraction: Extraction) throws -> [String: Any] {
        let root = try sourceRoot(handle)
        var parts = try components(path)
        let leaf = parts.removeLast()
        let parent = try traverse(root.directory.value, components: parts)
        let file = try Descriptor(openat(parent.value, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC))
        let before = try fingerprint(file.value)
        guard try status(file.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw BridgeFailure("nonRegularFile") }
        var digest = SHA256()
        var count = 0
        var content = Data()
        try readChunks(file.value) { bytes in
            content.append(bytes)
            digest.update(data: bytes); count += bytes.count
            try request.emit(["kind": "bytes", "bytes": bytes.base64EncodedString()])
        }
        let rawDigest = CodeMapRawSourceDigest(bytes: Data(digest.finalize()))
        let identity = SourceIdentity(sha256: rawDigest.lowercaseHex, byteCount: count)
        guard try fingerprint(file.value) == before else { throw BridgeFailure("sourceChanged") }
        if let expected, expected != identity { throw BridgeFailure("sourceChanged") }
        try validate(root)
        return try ["kind": "sourceComplete", "identity": identity.json, "fingerprint": before.json,
                    "decoding": RPCESourceDecoder.describe(RPCESourceDecoder.decode(content)),
                    "key": extraction.key(rawDigest, byteCount: count, extension: (path as NSString).pathExtension)]
    }

    func beginExport(_ handle: NativeHandle, name: String) throws -> [String: Any] {
        let root = try lookupRoot(handle)
        guard root.access == "output", try components(name).count == 1 else { throw BridgeFailure("invalidOutputCapability") }
        guard mkdirat(root.directory.value, name, 0o700) == 0 else { throw ioFailure() }
        let directory = try traverse(root.directory.value, components: [name])
        let info = try status(directory.value)
        let id = UUID().uuidString
        runs[id] = ExportRun(directory: directory, root: root, name: name, device: String(info.st_dev), inode: String(info.st_ino))
        return ["kind": "exportOpened", "run": NativeHandle(generation: generation, id: id).json]
    }

    func writeExport(_ handle: NativeHandle, filename: String, bytes: Data, publish: Bool) throws -> [String: Any] {
        let run = try lookupRun(handle)
        let file = try Descriptor(openat(run.directory.value, filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600))
        do {
            try bytes.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let written = write(file.value, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else { throw ioFailure() }
                    offset += written
                }
            }
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
        guard try status(file.value).st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw BridgeFailure("nonRegularFile") }
        let before = try fingerprint(file.value)
        var bytes = Data()
        try readChunks(file.value) { bytes.append($0) }
        guard try fingerprint(file.value) == before else { throw BridgeFailure("sourceChanged") }
        try validate(run)
        return ["kind": "exportRead", "bytes": bytes.base64EncodedString(), "identity": Extraction.identity(bytes).json]
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

    private func lookupRun(_ handle: NativeHandle) throws -> ExportRun {
        guard handle.generation == generation, let run = runs[handle.id] else { throw BridgeFailure("invalidExportHandle") }
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
        let reopened = try traverse(run.root.directory.value, components: [run.name])
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

private func openAbsoluteDirectory(_ path: String) throws -> Descriptor {
    let root = try Descriptor(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC))
    return try traverse(root.value, components: path == "/" ? [] : components(String(path.dropFirst())))
}

private func status(_ fd: Int32) throws -> stat {
    var result = stat()
    guard fstat(fd, &result) == 0 else { throw ioFailure() }
    return result
}

private struct DescriptorFingerprint: Equatable {
    let device: String
    let inode: String
    let size: Int64
    let mode: UInt32
    let modifiedSeconds: String
    let modifiedNanoseconds: Int
    let changedSeconds: String
    let changedNanoseconds: Int

    var json: [String: Any] {
        ["device": device, "inode": inode, "size": size, "mode": mode,
         "modifiedSeconds": modifiedSeconds, "modifiedNanoseconds": modifiedNanoseconds,
         "changedSeconds": changedSeconds, "changedNanoseconds": changedNanoseconds]
    }
}

private func fingerprint(_ fd: Int32) throws -> DescriptorFingerprint {
    let info = try status(fd)
    #if canImport(Darwin)
        let modified = info.st_mtimespec, changed = info.st_ctimespec
    #else
        let modified = info.st_mtim, changed = info.st_ctim
    #endif
    return DescriptorFingerprint(device: String(info.st_dev), inode: String(info.st_ino),
                                 size: Int64(info.st_size), mode: UInt32(info.st_mode),
                                 modifiedSeconds: String(modified.tv_sec), modifiedNanoseconds: Int(modified.tv_nsec),
                                 changedSeconds: String(changed.tv_sec), changedNanoseconds: Int(changed.tv_nsec))
}

private func ioFailure() -> BridgeFailure {
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
