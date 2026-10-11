// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: retain the caller-validated prefix contract with native visibility.
// swiftlint:disable unneeded_synthesized_initializer
/// Validated repository-relative prefixes are supplied by the repository owner.
/// FileSystem never resolves VCS configuration or acquires repository authority.
protocol IgnoreRepositoryRootPrefix: Sendable {
    var value: String { get }
}

struct IgnoreRootPrefix: IgnoreRepositoryRootPrefix, Equatable {
    let value: String

    /// The caller already owns prefix validation (e.g. GitRepositoryRelativeRootPrefix).
    init(value: String) {
        self.value = value
    }
}

// swiftlint:enable unneeded_synthesized_initializer
