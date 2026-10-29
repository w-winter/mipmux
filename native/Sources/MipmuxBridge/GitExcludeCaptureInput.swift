import Foundation

/// Reads a repository's Git exclude files as root-level ignore controls: the user's `core.excludesFile`, when one
/// applies, then `info/exclude` in the common Git directory, which Git ranks higher. An absent file is recorded as
/// absent.
struct GitExcludeCaptureInput {
    private let excludesFile: String?
    private let infoExclude: String
    private let deniedAbsolutePaths: [String]

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "excludesFile", "infoExclude", "deniedAbsolutePaths"])
        let excludesFile = try fields.value("excludesFile")
        guard excludesFile is NSNull || (excludesFile as? String)?.hasPrefix("/") == true,
              let paths = try fields.value("deniedAbsolutePaths") as? [String]
        else { throw BridgeFailure("nativeProtocolError") }
        self.excludesFile = excludesFile as? String
        infoExclude = try fields.string("infoExclude")
        guard infoExclude.hasPrefix("/") else { throw BridgeFailure("nativeProtocolError") }
        deniedAbsolutePaths = paths
    }

    func render(files: ConfinedFiles) throws -> [String: Any] {
        let named = (excludesFile.map { [($0, "core.excludesFile")] } ?? []) + [(infoExclude, "info/exclude")]
        let controls = try named.map { path, name in
            try ["path": path, "directory": "", "name": name, "authority": "gitExclude",
                 "content": files.readIgnoreControl(path, mandatory: false, denied: deniedAbsolutePaths)]
        }
        return ["kind": "gitExcludeInputs", "controls": controls]
    }
}
