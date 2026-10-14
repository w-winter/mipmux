enum GitOperation {
    case read(GitReadInput)
    case show(GitShowInput)
    case patch(GitPatchInput)
    case diff(GitDiffInput)
    case acquisition(GitDiffAcquisitionInput)
    case target(GitTargetInput)
    case targetRevalidation(GitTargetRevalidationInput)
    case snapshot(GitSnapshotInput)
    case artifacts(GitArtifactProjectionInput)
    case publicationMetadata(GitPublicationMetadataInput)

    func render() throws -> [String: Any] {
        switch self {
        case let .read(input): try input.render()
        case let .show(input): try input.render()
        case let .patch(input): input.render()
        case let .diff(input): try input.render()
        case let .acquisition(input): try input.render()
        case let .target(input): try input.render()
        case let .targetRevalidation(input): input.render()
        case let .snapshot(input): try input.render()
        case let .artifacts(input): try input.render()
        case let .publicationMetadata(input): try input.render()
        }
    }
}
