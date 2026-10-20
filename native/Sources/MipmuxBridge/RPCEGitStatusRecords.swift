// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: retain only the porcelain-v2 record types consumed by the source parser.
import Foundation

enum GitPorcelainV2RecordKind: Equatable {
    case ordinary
    case renamedOrCopied(originalPath: String, score: String)
    case unmerged
    case untracked
    case ignored
}

struct GitPorcelainV2PathRecord: Equatable {
    let kind: GitPorcelainV2RecordKind
    let path: String
    let indexStatus: Character?
    let workTreeStatus: Character?
    let submoduleState: String?
    let headMode: String?
    let indexMode: String?
    let workTreeMode: String?
    let headOID: String?
    let indexOID: String?
    let conflictStage1Mode: String?
    let conflictStage2Mode: String?
    let conflictStage3Mode: String?
    let conflictStage1OID: String?
    let conflictStage2OID: String?
    let conflictStage3OID: String?

    var hasIndexChange: Bool {
        guard let indexStatus else { return false }
        return indexStatus != "." && indexStatus != "?"
    }

    var hasWorkTreeChange: Bool {
        guard let workTreeStatus else { return false }
        return workTreeStatus != "." && workTreeStatus != "?"
    }

    init(
        kind: GitPorcelainV2RecordKind,
        path: String,
        indexStatus: Character? = nil,
        workTreeStatus: Character? = nil,
        submoduleState: String? = nil,
        headMode: String? = nil,
        indexMode: String? = nil,
        workTreeMode: String? = nil,
        headOID: String? = nil,
        indexOID: String? = nil,
        conflictStage1Mode: String? = nil,
        conflictStage2Mode: String? = nil,
        conflictStage3Mode: String? = nil,
        conflictStage1OID: String? = nil,
        conflictStage2OID: String? = nil,
        conflictStage3OID: String? = nil
    ) {
        self.kind = kind
        self.path = path
        self.indexStatus = indexStatus
        self.workTreeStatus = workTreeStatus
        self.submoduleState = submoduleState
        self.headMode = headMode
        self.indexMode = indexMode
        self.workTreeMode = workTreeMode
        self.headOID = headOID
        self.indexOID = indexOID
        self.conflictStage1Mode = conflictStage1Mode
        self.conflictStage2Mode = conflictStage2Mode
        self.conflictStage3Mode = conflictStage3Mode
        self.conflictStage1OID = conflictStage1OID
        self.conflictStage2OID = conflictStage2OID
        self.conflictStage3OID = conflictStage3OID
    }
}
