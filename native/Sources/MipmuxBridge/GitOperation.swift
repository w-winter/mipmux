enum GitOperation {
    case read(GitReadInput)
    case show(GitShowInput)
    case patch(GitPatchInput)
    case diff(GitDiffInput)
    case acquisition(GitDiffAcquisitionInput)
    case ownership(GitOwnershipOperation)
    case snapshot(GitSnapshotInput)
    case artifacts(GitArtifactProjectionInput)
    case artifactAuthorization(GitArtifactAuthorizationInput)
    case publicationMetadata(GitPublicationMetadataInput)
    case publicationOptions(GitPublicationOptionsInput)
    case worktree(GitWorktreeInput)
    case publicationPlan(GitPublicationPlanInput)

    // Each wire variant has one dispatch branch; CCCC checks decision complexity separately.
    // swiftlint:disable:next cyclomatic_complexity
    func render(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        switch self {
        case let .read(input): try input.render()
        case let .show(input): try input.render()
        case let .patch(input): input.render()
        case let .diff(input): try input.render()
        case let .acquisition(input): try input.render()
        case let .ownership(input): try await input.render(resolver: resolver)
        case let .snapshot(input): try input.render()
        case let .artifacts(input): try input.render()
        case let .artifactAuthorization(input): try input.render()
        case let .publicationMetadata(input): try input.render()
        case let .publicationOptions(input): try input.render()
        case let .worktree(input): try input.render()
        case let .publicationPlan(input): input.render()
        }
    }
}

enum GitOwnershipOperation {
    case target(GitTargetInput)
    case automaticReview(AutomaticReviewGitInput)
    case targetRevalidation(GitTargetRevalidationInput)

    func render(resolver: SelectedPathVCSResolver) async throws -> [String: Any] {
        switch self {
        case let .target(input): try await input.render(resolver: resolver)
        case let .automaticReview(input): try await input.render(resolver: resolver)
        case let .targetRevalidation(input): await input.render(resolver: resolver)
        }
    }
}
