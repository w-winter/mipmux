import Foundation

struct GitFingerprintInput {
    let root: NativeHandle
    private let compare: GitDiffCompareSpec
    private let headSHA: String
    private let baseRefSHA: String
    private let status: Data

    init(_ value: Any) throws {
        let fields = try WireObject(value, keys: ["kind", "root", "compare", "headSHA", "baseRefSHA", "status"])
        root = try NativeHandle(fields.value("root"))
        compare = try GitDiffCompareSpec.parse(fields.string("compare"))
        headSHA = try fields.string("headSHA")
        baseRefSHA = try fields.string("baseRefSHA")
        status = try fields.bytes("status")
    }

    func render(attributes: (String) throws -> [FileAttributeKey: Any]) throws -> [String: Any] {
        let fingerprint: GitDiffFingerprint
        switch compare {
        case let .uncommitted(base), let .uncommittedMergeBase(base), let .staged(base), let .stagedMergeBase(base):
            fingerprint = RPCEGitStatusFingerprint().fingerprint(
                headSHA: headSHA, baseRef: base, baseRefSHA: baseRefSHA, statusData: status, attributes: attributes
            )
        case .unstaged:
            fingerprint = GitDiffFingerprint(headSHA: headSHA, baseRef: "INDEX",
                                             statusHash: "index:\(RPCEGitStatusFingerprint.sha256Hex(status))",
                                             generatedAt: Date())
        case let .revspec(revspec):
            fingerprint = GitDiffFingerprint(headSHA: headSHA, baseRef: revspec,
                                             statusHash: "revspec:\(revspec)", generatedAt: Date())
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try ["kind": "gitDiffFingerprint", "fingerprint": decodeWireJSON(encoder.encode(fingerprint))]
    }
}
