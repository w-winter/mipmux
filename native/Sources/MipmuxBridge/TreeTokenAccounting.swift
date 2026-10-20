import Foundation

// RPCE TokenCalculationService's tree-estimation methods, without its app actor state.
enum TokenCalculationService {
    @inline(__always)
    static func estimateTokens(for text: String) -> Int {
        estimateTokens(utf8ByteCount: text.utf8.count)
    }

    @inline(__always)
    static func estimateTokens(utf8ByteCount: Int) -> Int {
        precondition(utf8ByteCount >= 0, "UTF-8 byte count must be nonnegative")
        return Int((Double(utf8ByteCount) / 4.0) * 1.05)
    }
}
