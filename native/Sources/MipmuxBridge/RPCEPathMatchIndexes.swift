// Retained source identifiers and layout; CCCC enforces the configured complexity limits.
// swiftlint:disable for_where identifier_name optional_data_string_conversion
import Foundation

struct PathMatchIndexes {
    let byFileName: [String: [FileRecord]]
    let byLastTwo: [String: [FileRecord]]
    let byExtension: [String: [FileRecord]]
    let foldersByLastComponent: [String: [FolderRecord]]

    static func canonical(_ s: String, caseSensitive: Bool) -> String {
        // Quick ASCII probe: if all bytes < 0x80, skip folding entirely
        var isASCII = true
        for b in s.utf8 {
            if b >= 0x80 { isASCII = false
                break
            }
        }
        let input = isASCII ? s : PathCharPolicy.foldHomoglyphsIfNeeded(s)
        // Fast path: ASCII-only scan using UTF-8 bytes; avoid CharacterSet/CF calls entirely
        var sawNonASCII = false
        var out = [UInt8]()
        out.reserveCapacity(input.utf8.count)

        for b in input.utf8 {
            if b < 0x80 {
                if PathCharPolicy.isAllowedASCIIByte(b) {
                    out.append(caseSensitive ? b : PathCharPolicy.toLowerASCII(b))
                }
            } else {
                sawNonASCII = true
            }
        }

        if !sawNonASCII {
            // ASCII-only: already filtered & case-normalized (if requested)
            return String(decoding: out, as: UTF8.self)
        }

        // Slow path: Unicode scalars (rare); keep alphanumerics + our ASCII punctuation
        var scalars = String.UnicodeScalarView()
        scalars.reserveCapacity(input.unicodeScalars.count)
        for sc in input.unicodeScalars {
            // After pre-folding, we can append as-is in the fallback
            if sc.value < 0x80 {
                if PathCharPolicy.isAllowedASCIIByte(UInt8(truncatingIfNeeded: sc.value)) {
                    scalars.append(sc)
                }
            } else if CharacterSet.alphanumerics.contains(sc) {
                scalars.append(sc)
            }
        }
        let filtered = String(scalars)
        return caseSensitive ? filtered : filtered.lowercased()
    }

    static func build(
        files: [String: FileRecord],
        folders: [String: FolderRecord],
        caseSensitive: Bool
    ) -> PathMatchIndexes {
        var byFileName: [String: [FileRecord]] = [:]
        var byLastTwo: [String: [FileRecord]] = [:]
        var byExtension: [String: [FileRecord]] = [:]
        var foldersByLastComponent: [String: [FolderRecord]] = [:]

        // Files
        for (_, file) in files {
            let nameKey = canonical(file.name, caseSensitive: caseSensitive)
            byFileName[nameKey, default: []].append(file)

            let ext = (file.name as NSString).pathExtension.lowercased()
            if !ext.isEmpty {
                byExtension[ext, default: []].append(file)
            }

            let comps = file.relativePath.split(separator: "/").map(String.init)
            if comps.count >= 2 {
                let lastTwo = comps[comps.count - 2] + "/" + comps[comps.count - 1]
                let key2 = canonical(lastTwo, caseSensitive: caseSensitive)
                byLastTwo[key2, default: []].append(file)
            }
        }

        // Folders
        for (_, folder) in folders {
            let lastKey = canonical(folder.name, caseSensitive: caseSensitive)
            foldersByLastComponent[lastKey, default: []].append(folder)
        }

        return PathMatchIndexes(
            byFileName: byFileName,
            byLastTwo: byLastTwo,
            byExtension: byExtension,
            foldersByLastComponent: foldersByLastComponent
        )
    }
}

enum PathLocateProfile: Hashable {
    case uiAssisted
    case mcpRead
    case mcpSelection
    case mcpSearchScope
    case moveSourceExact
    case createBestEffort
    case createRequireUnambiguous

    var options: PathLocateOptions {
        switch self {
        case .uiAssisted:
            PathLocateOptions(
                exactMatchOnly: false,
                allowLeadingRootAliasTrim: true,
                allowHeadTrimAliases: true,
                allowAbsoluteSuffixFallback: true,
                useSelectedRootBias: true
            )
        case .mcpRead, .mcpSelection, .mcpSearchScope:
            PathLocateOptions(
                exactMatchOnly: false,
                allowLeadingRootAliasTrim: true,
                allowHeadTrimAliases: true,
                allowAbsoluteSuffixFallback: true,
                useSelectedRootBias: false
            )
        case .moveSourceExact:
            PathLocateOptions(
                exactMatchOnly: true,
                allowLeadingRootAliasTrim: true,
                allowHeadTrimAliases: false,
                allowAbsoluteSuffixFallback: false,
                useSelectedRootBias: false
            )
        case .createBestEffort:
            PathLocateOptions(
                exactMatchOnly: false,
                allowLeadingRootAliasTrim: true,
                allowHeadTrimAliases: true,
                allowAbsoluteSuffixFallback: false,
                useSelectedRootBias: true
            )
        case .createRequireUnambiguous:
            PathLocateOptions(
                exactMatchOnly: false,
                allowLeadingRootAliasTrim: true,
                allowHeadTrimAliases: true,
                allowAbsoluteSuffixFallback: false,
                useSelectedRootBias: false
            )
        }
    }
}

struct PathLocateOptions: Equatable {
    let exactMatchOnly: Bool
    let allowLeadingRootAliasTrim: Bool
    let allowHeadTrimAliases: Bool
    let allowAbsoluteSuffixFallback: Bool
    let useSelectedRootBias: Bool
}

/// Helper enum for handling heterogeneous file/folder collections
enum AnyItem {
    case folder(FolderRecord)
    case file(FileRecord)

    var name: String {
        switch self {
        case let .folder(f): f.name
        case let .file(f): f.name
        }
    }

    var rootPath: String {
        switch self {
        case let .folder(f): f.rootPath
        case let .file(f): f.rootFolderPath
        }
    }

    var relativePath: String {
        switch self {
        case let .folder(f): f.relativePath
        case let .file(f): f.relativePath
        }
    }
}

// swiftlint:enable for_where identifier_name optional_data_string_conversion
