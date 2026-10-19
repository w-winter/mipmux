import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

enum AtomicFile {
    static func replace(_ parent: Int32, filename: String, bytes: Data) throws {
        var existing = stat()
        if fstatat(parent, filename, &existing, AT_SYMLINK_NOFOLLOW) == 0 {
            guard existing.st_mode & mode_t(S_IFMT) != mode_t(S_IFLNK) else { throw BridgeFailure("symlink") }
            guard existing.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw BridgeFailure("nonRegularFile") }
        } else if errno != ENOENT { throw ioFailure() }
        try temporary(parent, bytes: bytes) { name in
            guard renameat(parent, name, parent, filename) == 0 else { throw ioFailure() }
        }
    }

    static func create(_ parent: Int32, filename: String, bytes: Data) throws {
        try temporary(parent, bytes: bytes) { name in
            // linkat commits complete bytes and atomically rejects every existing destination, including symlinks.
            guard linkat(parent, name, parent, filename, 0) == 0 else { throw ioFailure() }
        }
    }

    private static func temporary(_ parent: Int32, bytes: Data, commit: (String) throws -> Void) throws {
        let name = ".snapshot-" + UUID().uuidString
        let descriptor = try Descriptor(openat(
            parent,
            name,
            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
            0o600
        ))
        defer { unlinkat(parent, name, 0) }
        try writeBytes(bytes, descriptor: descriptor.value)
        guard fsync(descriptor.value) == 0 else { throw ioFailure() }
        try descriptor.finish()
        try commit(name)
        guard fsync(parent) == 0 else { throw ioFailure() }
    }

    static func writeBytes(_ bytes: Data, descriptor: Int32) throws {
        try bytes.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var offset = 0
            while offset < buffer.count {
                let written = write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if written < 0, errno == EINTR { continue }
                guard written > 0 else { throw ioFailure() }
                offset += written
            }
        }
    }
}
