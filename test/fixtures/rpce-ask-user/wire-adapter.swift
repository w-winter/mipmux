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
        let value = try text(name)
        guard !value.utf8.contains(0) else {
            throw BridgeFailure("nativeProtocolError")
        }
        return value
    }

    func text(_ name: String) throws -> String {
        guard let value = fields[name] as? String else { throw BridgeFailure("nativeProtocolError") }
        return value
    }

    func value(_ name: String) throws -> Any {
        guard let value = fields[name] else { throw BridgeFailure("nativeProtocolError") }
        return value
    }

    func boolean(_ name: String) throws -> Bool {
        guard let value = fields[name] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID()
        else { throw BridgeFailure("nativeProtocolError") }
        return value.boolValue
    }

    func count(_ name: String) throws -> Int {
        guard let value = fields[name] as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991,
              value.doubleValue == Double(value.intValue)
        else { throw BridgeFailure("nativeProtocolError") }
        return value.intValue
    }

    func integer(_ name: String) throws -> Int {
        guard let value = fields[name] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              abs(value.doubleValue) <= 9_007_199_254_740_991, value.doubleValue == Double(value.intValue)
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
