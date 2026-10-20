public enum SliceMutationMode: Sendable {
    case add
    case set
    case remove
    case setPaths // file-scoped replacement: replace slices only for specified files
}
