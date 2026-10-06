import CoreFoundation
import Foundation

struct BridgeFailure: Error {
    let code: String
    let number: Int32?
    init(_ code: String, _ number: Int32? = nil) {
        self.code = code; self.number = number
    }
}

struct WireObject {
    let fields: [String: Any]
    init(_ value: Any, keys: Set<String>) throws {
        guard let fields = value as? [String: Any], Set(fields.keys) == keys else {
            throw BridgeFailure("nativeProtocolError")
        }
        self.fields = fields
    }

    func string(_ name: String) throws -> String {
        guard let value = fields[name] as? String, !value.utf8.contains(0) else {
            throw BridgeFailure("nativeProtocolError")
        }
        return value
    }

    func value(_ name: String) throws -> Any {
        guard let value = fields[name] else { throw BridgeFailure("nativeProtocolError") }
        return value
    }

    func count(_ name: String) throws -> Int {
        guard let value = fields[name] as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
              value.doubleValue == Double(value.intValue)
        else { throw BridgeFailure("nativeProtocolError") }
        return value.intValue
    }

    func bytes(_ name: String) throws -> Data {
        let encoded = try string(name)
        guard let bytes = Data(base64Encoded: encoded), bytes.base64EncodedString() == encoded else {
            throw BridgeFailure("nativeProtocolError")
        }
        return bytes
    }
}

struct SourceIdentity: Codable, Equatable {
    let sha256: String
    let byteCount: Int
    init(sha256: String, byteCount: Int) {
        self.sha256 = sha256; self.byteCount = byteCount
    }

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["sha256", "byteCount"])
        sha256 = try object.string("sha256")
        byteCount = try object.count("byteCount")
        guard sha256.utf8.count == 64, sha256.utf8.allSatisfy({ (48 ... 57).contains($0) || (97 ... 102).contains($0) }) else {
            throw BridgeFailure("nativeProtocolError")
        }
    }

    var json: [String: Any] {
        ["sha256": sha256, "byteCount": byteCount]
    }
}

struct NativeHandle {
    let generation: String
    let id: String
    init(generation: String, id: String) {
        self.generation = generation; self.id = id
    }

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["generation", "id"])
        generation = try object.string("generation")
        id = try object.string("id")
        guard !generation.isEmpty, !id.isEmpty else { throw BridgeFailure("nativeProtocolError") }
    }

    var json: [String: Any] {
        ["generation": generation, "id": id]
    }
}

struct RootIdentity: Codable, Equatable {
    let declaredPath: String
    let canonicalPath: String
    let device: String
    let inode: String
    static func == (lhs: Self, rhs: Self) -> Bool {
        Data(lhs.declaredPath.utf8) == Data(rhs.declaredPath.utf8) &&
            Data(lhs.canonicalPath.utf8) == Data(rhs.canonicalPath.utf8) &&
            lhs.device == rhs.device && lhs.inode == rhs.inode
    }

    var json: [String: Any] {
        ["declaredPath": declaredPath, "canonicalPath": canonicalPath, "device": device, "inode": inode]
    }

    init(declaredPath: String, canonicalPath: String, device: String, inode: String) {
        self.declaredPath = declaredPath; self.canonicalPath = canonicalPath
        self.device = device; self.inode = inode
    }

    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["declaredPath", "canonicalPath", "device", "inode"])
        declaredPath = try object.string("declaredPath"); canonicalPath = try object.string("canonicalPath")
        device = try object.string("device"); inode = try object.string("inode")
    }
}

struct RootDeclaration {
    let name: String
    let absolutePath: String
    let access: String
    let expected: RootIdentity?
    init(_ value: Any) throws {
        let object = try WireObject(value, keys: ["name", "absolutePath", "access", "expected"])
        name = try object.string("name"); absolutePath = try object.string("absolutePath"); access = try object.string("access")
        expected = object.fields["expected"] is NSNull ? nil : try RootIdentity(object.value("expected"))
        guard name.range(of: "^[A-Za-z][A-Za-z0-9_-]*\\z", options: .regularExpression) != nil,
              absolutePath.hasPrefix("/"), ["source", "output"].contains(access)
        else { throw BridgeFailure("nativeProtocolError") }
    }
}

enum Operation {
    case describe
    case openRoots([RootDeclaration])
    case listDirectory(NativeHandle, String?)
    case readSource(NativeHandle, String, SourceIdentity?)
    case extract(String, Data, SourceIdentity)
    case beginExport(NativeHandle, String)
    case writeExport(NativeHandle, String, Data)
    case readExport(NativeHandle, String)
    case publishManifest(NativeHandle, Data)

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any], let kind = raw["kind"] as? String else { throw BridgeFailure("nativeProtocolError") }
        switch kind {
        case "describe":
            _ = try WireObject(value, keys: ["kind"]); self = .describe
        case "openRoots":
            let o = try WireObject(value, keys: ["kind", "roots"])
            guard let roots = o.fields["roots"] as? [Any], !roots.isEmpty else { throw BridgeFailure("nativeProtocolError") }
            self = try .openRoots(roots.map(RootDeclaration.init))
        case "listDirectory":
            let o = try WireObject(value, keys: ["kind", "root", "directory"])
            guard let directory = o.fields["directory"] as? [String: Any] else { throw BridgeFailure("nativeProtocolError") }
            let path: String?
            if directory["kind"] as? String == "root" {
                _ = try WireObject(directory, keys: ["kind"]); path = nil
            } else {
                let d = try WireObject(directory, keys: ["kind", "path"])
                guard try d.string("kind") == "descendant" else { throw BridgeFailure("nativeProtocolError") }
                path = try d.string("path")
            }
            self = try .listDirectory(NativeHandle(o.value("root")), path)
        case "readSource":
            let o = try WireObject(value, keys: ["kind", "root", "path", "expected"])
            self = try .readSource(NativeHandle(o.value("root")), o.string("path"), o.fields["expected"] is NSNull ? nil : SourceIdentity(o.value("expected")))
        case "extract":
            let o = try WireObject(value, keys: ["kind", "extension", "bytes", "expected"])
            self = try .extract(o.string("extension"), o.bytes("bytes"), SourceIdentity(o.value("expected")))
        case "beginExport":
            let o = try WireObject(value, keys: ["kind", "root", "name"])
            self = try .beginExport(NativeHandle(o.value("root")), o.string("name"))
        case "writeExport", "readExport":
            let keys: Set<String> = kind == "writeExport" ? ["kind", "run", "filename", "bytes"] : ["kind", "run", "filename"]
            let o = try WireObject(value, keys: keys)
            let filename = try o.string("filename")
            guard ["context.md", "handoff.md"].contains(filename) else { throw BridgeFailure("nativeProtocolError") }
            let handle = try NativeHandle(o.value("run"))
            self = try kind == "writeExport" ? .writeExport(handle, filename, o.bytes("bytes")) : .readExport(handle, filename)
        case "publishManifest":
            let o = try WireObject(value, keys: ["kind", "run", "bytes"])
            self = try .publishManifest(NativeHandle(o.value("run")), o.bytes("bytes"))
        default: throw BridgeFailure("nativeProtocolError")
        }
    }
}

struct Request {
    let id: String
    let generation: String
    let operation: Operation
    init(_ bytes: Data, generation: String) throws {
        guard let string = String(data: bytes, encoding: .utf8), Data(string.utf8) == bytes else { throw BridgeFailure("nativeProtocolError") }
        let object = try WireObject(JSONSerialization.jsonObject(with: bytes), keys: ["wireVersion", "requestId", "generation", "operation"])
        id = try object.string("requestId")
        self.generation = try object.string("generation")
        guard try object.count("wireVersion") == 1, self.generation == generation, !id.isEmpty else { throw BridgeFailure("nativeProtocolError") }
        operation = try Operation(object.value("operation"))
    }

    func emit(_ fields: [String: Any]) throws {
        var value = fields
        value["wireVersion"] = 1; value["requestId"] = id; value["generation"] = generation
        var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
        bytes.append(0x0A)
        try FileHandle.standardOutput.write(contentsOf: bytes)
    }

    func terminal(_ result: [String: Any]) throws {
        try emit(["kind": "terminal", "result": result])
    }
}
