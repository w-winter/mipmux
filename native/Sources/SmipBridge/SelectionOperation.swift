enum SelectionOperation {
    case transition(SelectionTransitionInput)
    case sliceRanges(SliceRangesInput)
    case candidates(SelectionCandidatesInput)
    case paths(SelectionPathMutationInput)
    case preparation(SelectionPreparationInput)
    case parse(SelectionInputParsing)

    func render() async -> [String: Any] {
        switch self {
        case let .transition(input): input.render()
        case let .sliceRanges(input): input.render()
        case let .candidates(input): await input.render()
        case let .paths(input): await input.render()
        case let .preparation(input): await input.render()
        case let .parse(input): input.render()
        }
    }
}
