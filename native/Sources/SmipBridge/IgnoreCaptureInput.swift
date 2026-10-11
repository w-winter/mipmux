import Foundation

struct IgnoreCaptureInput {
    let root: NativeHandle
    let directory: String?
    let settings: IgnoreSettings
    let deniedAbsolutePaths: [String]

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "root", "directory", "settings", "deniedAbsolutePaths"])
        root = try NativeHandle(fields.value("root"))
        let directoryValue = try fields.value("directory")
        guard let object = directoryValue as? [String: Any], let kind = object["kind"] as? String else {
            throw BridgeFailure("nativeProtocolError")
        }
        if kind == "root" {
            _ = try WireObject(directoryValue, keys: ["kind"])
            directory = nil
        } else {
            let path = try WireObject(directoryValue, keys: ["kind", "path"])
            guard try path.string("kind") == "descendant" else { throw BridgeFailure("nativeProtocolError") }
            directory = try path.string("path")
        }
        settings = try IgnoreSettings(fields.value("settings"))
        guard let paths = try fields.value("deniedAbsolutePaths") as? [String],
              paths.allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") })
        else {
            throw BridgeFailure("nativeProtocolError")
        }
        deniedAbsolutePaths = paths
    }

    private init(root: NativeHandle, directory: String, settings: IgnoreSettings, denied: [String]) {
        self.root = root
        self.directory = directory
        self.settings = settings
        deniedAbsolutePaths = denied
    }

    func atDirectory(_ path: String) -> IgnoreCaptureInput {
        IgnoreCaptureInput(root: root, directory: path, settings: settings, denied: deniedAbsolutePaths)
    }
}
