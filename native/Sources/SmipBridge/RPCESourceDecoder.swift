import CoreFoundation
import Foundation
import RepoPromptC
import RepoPromptCodeMapCore
import UniversalCharsetDetection

/// RPCE automatic decoding; Linux reports detector failure and uses native codec conversion.
enum RPCESourceDecoder {
    static var policy: CodeMapSourceDecoderPolicy {
        #if os(Linux)
            .workspaceAutomaticLinuxV1
        #else
            .workspaceAutomaticV1
        #endif
    }

    static var identifier: String {
        #if os(Linux)
            "workspace-automatic-linux-v1"
        #else
            "workspace-automatic-v1"
        #endif
    }

    static func decode(_ data: Data) -> CodeMapSourceDecodeResult {
        if data.isEmpty {
            return .decoded(CodeMapDecodedSource(text: "", detectedEncodingRawValue: String.Encoding.utf8.rawValue))
        }
        if let utf8String = String(data: data, encoding: .utf8) {
            return .decoded(CodeMapDecodedSource(
                text: utf8String, detectedEncodingRawValue: String.Encoding.utf8.rawValue
            ))
        }
        #if os(Linux)
            guard let label = data.detectedCharacterEncoding,
                  let string = convert(data, encoding: label)
            else { return .failed(.undecodable) }
            return .decoded(CodeMapDecodedSource(text: string, detectedEncodingRawValue: encoding(label).rawValue))
        #else
            let selectedEncoding = detectEncodingFull(data)
            guard let string = String(data: data, encoding: selectedEncoding) else { return .failed(.undecodable) }
            return .decoded(CodeMapDecodedSource(text: string, detectedEncodingRawValue: selectedEncoding.rawValue))
        #endif
    }

    private static func encoding(_ label: String) -> String.Encoding {
        #if os(Linux)
            let name = label.withCString { CFStringCreateWithCString(nil, $0, CFStringBuiltInEncodings.UTF8.rawValue) }!
        #else
            let name = label as CFString
        #endif
        let value = CFStringConvertIANACharSetNameToEncoding(name)
        return String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(value))
    }

    static func describe(_ result: CodeMapSourceDecodeResult) -> [String: Any] {
        switch result {
        case let .decoded(source):
            ["kind": "decoded", "text": source.text,
             "identity": Extraction.identity(Data(source.text.utf8)).json,
             "encoding": source.detectedEncodingRawValue]
        case .failed:
            ["kind": "undecodable"]
        }
    }
}

#if os(Linux)
    private extension RPCESourceDecoder {
        static func convert(_ data: Data, encoding: String) -> String? {
            var output: UnsafeMutablePointer<UInt8>?
            var count = 0
            let status = data.withUnsafeBytes { input in
                encoding.withCString { label in
                    smip_decode_utf8(input.baseAddress, input.count, label, &output, &count)
                }
            }
            guard status == 0, let output else { return nil }
            defer { free(output) }
            return String(data: Data(bytes: output, count: count), encoding: .utf8)
        }
    }
#else
    private extension RPCESourceDecoder {
        static func detectEncodingFull(_ data: Data) -> String.Encoding {
            if let label = data.detectedCharacterEncoding {
                return encoding(label)
            }
            var lossy = ObjCBool(false)
            let guess = NSString.stringEncoding(
                for: data,
                encodingOptions: [:],
                convertedString: nil,
                usedLossyConversion: &lossy
            )
            return guess != 0 ? .init(rawValue: guess) : .utf8
        }
    }
#endif
