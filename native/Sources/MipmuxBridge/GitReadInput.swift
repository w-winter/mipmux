import Foundation

struct GitReadInput {
    private enum Query {
        case status
        case log(count: Int, path: String?)
        case blame(path: String, lines: ClosedRange<Int>?)
    }

    private enum Work {
        case arguments
        case projection(Data)
    }

    private let query: Query
    private let work: Work

    init(_ value: Any) throws {
        guard let raw = value as? [String: Any],
              let kind = raw["kind"] as? String else { throw BridgeFailure("nativeProtocolError") }
        let keys: Set<String> = kind == "prepareGitRead" ? ["kind", "query"] : ["kind", "query", "bytes"]
        let input = try WireObject(value, keys: keys)
        work = try kind == "prepareGitRead" ? .arguments : .projection(input.bytes("bytes"))
        guard let object = try input.value("query") as? [String: Any],
              let operation = object["op"] as? String else { throw BridgeFailure("nativeProtocolError") }
        let args = try JSONDecoder().decode(
            [String: SelectionJSONValue].self,
            from: JSONSerialization.data(withJSONObject: object)
        )
        if operation == "status" {
            _ = try WireObject(object, keys: ["op"])
            query = .status
        } else if operation == "log" {
            _ = try WireObject(object, keys: ["op", "count", "path"])
            query = .log(count: args["count"]?.intValue ?? 10, path: args["path"]?.stringValue)
        } else if operation == "blame" {
            let fields = try WireObject(object, keys: ["op", "path", "lines"])
            var lineRange: ClosedRange<Int>?
            if let linesStr = args["lines"]?.stringValue {
                let parts = linesStr.split(separator: "-").map { Int($0.trimmingCharacters(in: .whitespaces)) }
                if parts.count == 2, let start = parts[0], let end = parts[1], start <= end {
                    lineRange = start ... end
                }
            }
            query = try .blame(path: fields.string("path"), lines: lineRange)
        } else { throw BridgeFailure("nativeProtocolError") }
    }

    func render() throws -> [String: Any] {
        switch work {
        case .arguments:
            let args: [String] = switch query {
            case .status: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]
            case let .log(count, path): RPCEGitLog().arguments(count: count, path: path)
            case let .blame(path, lines): RPCEGitBlame().arguments(path: path, lineRange: lines)
            }
            return ["kind": "gitReadArguments", "args": args]
        case let .projection(bytes):
            guard let stdout = String(data: bytes, encoding: .utf8) else { throw BridgeFailure("gitOutputUndecodable") }
            switch query {
            case .status:
                return try RPCEGitStatus().project(stdout)
            case .log:
                return ["kind": "gitLog", "commits": RPCEGitLog().parseLogSummaries(stdout).map { row in
                    ["sha": row.sha, "short_sha": row.shortSHA, "author": row.author, "date": row.dateISO,
                     "message": row.message, "files_changed": row.filesChanged, "insertions": row.insertions,
                     "deletions": row.deletions]
                }]
            case .blame:
                return ["kind": "gitBlame", "lines": RPCEGitBlame().parseBlameOutput(stdout).map { row in
                    ["num": row.line, "sha": row.sha, "author": row.author, "date": row.dateISO, "content": row.content]
                }]
            }
        }
    }
}
