import Foundation
#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

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
