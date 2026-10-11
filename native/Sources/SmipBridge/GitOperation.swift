enum GitOperation {
    case read(GitReadInput)
    case show(GitShowInput)
    case patch(GitPatchInput)
    case diff(GitDiffInput)

    func render() throws -> [String: Any] {
        switch self {
        case let .read(input): try input.render()
        case let .show(input): try input.render()
        case let .patch(input): input.render()
        case let .diff(input): try input.render()
        }
    }
}
