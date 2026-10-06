// swift-tools-version: 6.2
import Foundation
import PackageDescription

guard let prefix = ProcessInfo.processInfo.environment["SMIP_PCRE2_PREFIX"],
      prefix.hasPrefix("/"),
      FileManager.default.fileExists(atPath: prefix + "/lib/libpcre2-8.a"),
      FileManager.default.fileExists(atPath: prefix + "/lib/pkgconfig/libpcre2-8.pc")
else { fatalError("Build through node scripts/build-native.mjs using the verified private PCRE2 prefix.") }
let swift6LanguageMode: [SwiftSetting] = [.swiftLanguageMode(.v6)]
let package = Package(name: "SmipNative", platforms: [.macOS(.v14)], products: [.executable(name: "SmipBridge", targets: ["SmipBridge"])], dependencies: [
    .package(url: "https://github.com/apple/swift-crypto.git", exact: "4.5.1"),
    .package(url: "https://github.com/repoprompt/swift-tree-sitter.git", revision: "a778ef4fb7f0d3ad00185f42ce83c688373c4361"),
    .package(url: "https://github.com/tree-sitter/tree-sitter", exact: "0.25.10"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-c", exact: "0.24.2"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-c-sharp.git", exact: "0.23.5"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-cpp", exact: "0.23.4"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-go", exact: "0.25.0"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-java", exact: "0.23.5"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-javascript", exact: "0.25.0"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-php.git", exact: "0.24.2"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-python", exact: "0.25.0"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-ruby", exact: "0.23.1"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-rust", exact: "0.24.2"),
    .package(url: "https://github.com/alex-pinkus/tree-sitter-swift", exact: "0.7.3-with-generated-files"),
    .package(url: "https://github.com/tree-sitter/tree-sitter-typescript", exact: "0.23.2"),
], targets: [
    .executableTarget(name: "SmipBridge", dependencies: ["RepoPromptCodeMapCore", "RepoPromptRegexCore", "CPCRE2", .product(name: "Crypto", package: "swift-crypto")], swiftSettings: swift6LanguageMode),
    .target(
        name: "RepoPromptRegexCore",
        dependencies: ["CSwiftPCRE2"],
        path: "Sources/RepoPromptRegexCore",
        swiftSettings: swift6LanguageMode,
    ),
    .target(
        name: "RepoPromptCodeMapCore",
        dependencies: [
            "RepoPromptRegexCore",
            .product(name: "Crypto", package: "swift-crypto"),
            "TreeSitterScannerSupport",
            .product(name: "SwiftTreeSitter", package: "swift-tree-sitter"),
            .product(name: "TreeSitterC", package: "tree-sitter-c"),
            .product(name: "TreeSitterGo", package: "tree-sitter-go"),
            .product(name: "TreeSitterJava", package: "tree-sitter-java"),
            .product(name: "TreeSitterJavaScript", package: "tree-sitter-javascript"),
            .product(name: "TreeSitterPython", package: "tree-sitter-python"),
            .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
            .product(name: "TreeSitterTypeScript", package: "tree-sitter-typescript"),
            .product(name: "TreeSitterRuby", package: "tree-sitter-ruby"),
            .product(name: "TreeSitterSwift", package: "tree-sitter-swift"),
            .product(name: "TreeSitterCSharp", package: "tree-sitter-c-sharp"),
            .product(name: "TreeSitterCPP", package: "tree-sitter-cpp"),
            .product(name: "TreeSitterPHP", package: "tree-sitter-php"),
        ],
        path: "Sources/RepoPromptCodeMapCore",
        swiftSettings: swift6LanguageMode + [
            .define("DEBUG", .when(configuration: .debug)),
        ],
    ),
    .systemLibrary(name: "CPCRE2", pkgConfig: "libpcre2-8"),
    .target(name: "CSwiftPCRE2", dependencies: ["CPCRE2"], publicHeadersPath: "include"),
    .target(name: "TreeSitterScannerSupport", path: "Sources/TreeSitterScannerSupport", sources: ["src/javascript/scanner.c", "src/python/scanner.c"], publicHeadersPath: "include"),
    .testTarget(name: "RepoPromptRegexCoreTests", dependencies: ["RepoPromptRegexCore"], swiftSettings: swift6LanguageMode),
    .testTarget(name: "RepoPromptCodeMapCoreTests", dependencies: ["RepoPromptCodeMapCore", .product(name: "Crypto", package: "swift-crypto")], resources: [.copy("Fixtures"), .copy("Goldens")], swiftSettings: swift6LanguageMode),
])
