// Modified for mipmux: declarations relocated and cross-file access adjusted.
//
//  LanguageTypeExtractor.swift
//  RepoPrompt
//
//  Updated to handle additional edge cases such as:
//   - C++ trailing return (auto foo(...) -> ReturnType)
//   - Go multiple return types (func foo(...) (T1, T2))
//   - Swift generics right after function name (func name<T: Foo>...)
//   - TypeScript generics right after function name (function name<T extends Foo>...)
//   - TS "type Foo = ..." lines
//   - Python def ...: regex anchored to handle trailing colon.
//
//  The updated regex patterns and logic aim to fix test mismatches.
//  We also do a final .trimmingCharacters(in: .whitespacesAndNewlines)
//  on return types and param types to avoid trailing spaces.
//

import Foundation

/// A single struct holding all enhanced regex patterns and static helper methods
/// to extract variables and functions from lines of code for each language.
///
/// Each regex tries to capture relevant groups:
///   - For variables: "type" and "name"
///   - For functions: "returnType", "name", "paramList"
///
/// The main static struct that holds all regex patterns and
/// top-level “matchAny…” methods for variables & functions.
enum LanguageTypeExtractor {
    // SAFETY: These immutable standard-library Regex values are initialized once
    // and used only through nonmutating matching. Their type-erased outputs do
    // not currently carry Sendable conformance.
    // MARK: - Swift Patterns

    /// Now allows optional `<...>` generics right after function name.
    // MARK: - Swift Patterns

    /// Now allows optional `<...>` generics right after function name,
    /// plus newly added keywords such as weak, unowned, dynamic, distributed, isolated, etc.
    static let swiftFunctionRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^
    (?:[-*]\s*)?
    \s*
    (?:@[A-Za-z_]\w*(?:\([^)]*\))?\s*)*
    (?:
       (?:private\(set\)|public|private|internal|fileprivate|open|
       class|static|final|lazy|override|mutating|actor|async|
       nonisolated|isolated|required|convenience|indirect|inout|
       rethrows|throws|weak|unowned|dynamic|distributed)
       \s+
    )*
    func\s+
    ([A-Za-z_]\w*)
    (?:<[^>]+>)?    # <-- optional generics
    \s*
    \(
       ([^)]*)
    \)
    # Allow repeated groups of 'throws', 'rethrows', 'async' in any order
    (?:\s+(?:throws|rethrows|async))*
    # Optional return type
    (?:\s*->\s*(?:some\s+|any\s+)?([A-Za-z_\[\(][A-Za-z0-9_!\?\<\>\.\[\]\(\)\ \:\&\-]*))?
    \s*
    .*$
    """#)

    /// Updated with new Swift keywords for var/let.
    static let swiftVariableRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^
    (?:[-*]\s*)?
    \s*
    (?:@[A-Za-z_]\w*(?:\([^)]*\))?\s*)*
    (?:
       (?:private\(set\)|public|private|internal|fileprivate|open|class|static|final|lazy|override|mutating|actor|inout|
       required|convenience|indirect|weak|unowned|dynamic|distributed|isolated)
       \s+
    )*
    (?:var|let)\s+
    ([A-Za-z_]\w*)
    (?:\s*:\s*
     ([^=]+)
    )?
    .*$
    """#)

    // MARK: - C# Patterns

    nonisolated(unsafe) static let cSharpVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:public|private|protected|internal)?\s*
    (?:static\s+|const\s+|readonly\s+|volatile\s+|unsafe\s+)*
    ([A-Za-z_][A-Za-z0-9_\.\[\]]*
     (?:<[^>]+>)?
     \??)
    \s+(\**[A-Za-z_]\w*)
    """#)

    nonisolated(unsafe) static let cSharpFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:public|private|protected|internal)?\s*
    (?:static\s+|sealed\s+|override\s+|abstract\s+|virtual\s+|unsafe\s+|async\s+)*
    ([A-Za-z_][A-Za-z0-9_\.<>\?\[\]&]+)
    \s+
    ([A-Za-z_]\w*)
    \s*\(
       ([^)]*)
    \)
    """#)

    // MARK: - Java

    nonisolated(unsafe) static let javaVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:public|private|protected)?\s*
    (?:static\s+|final\s+)*
    ([A-Za-z_][A-Za-z0-9_\.\[\]]*
     (?:<[^>]+>)?
    )
    \s+([A-Za-z_]\w*)
    """#)

    nonisolated(unsafe) static let javaFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:public|private|protected)?\s*
    (?:static\s+|final\s+|synchronized\s+|abstract\s+)*
    ([A-Za-z_][A-Za-z0-9_\.\[\]]*(?:<[^>]+>)?)
    \s+
    ([A-Za-z_]\w*)
    \s*\(
       ([^)]*)
    \)
    """#)

    // MARK: - C

    nonisolated(unsafe) static let cVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:extern|static|register)?\s*
    (?:const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+)*
    ([A-Za-z_][A-Za-z0-9_]*)
    (?:\s*\*+\s*)?
    \s+([A-Za-z_]\w*)
    """#)

    nonisolated(unsafe) static let cFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:extern|static)?\s*
    (?:inline\s+|const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+)*
    ([A-Za-z_][A-Za-z0-9_\*]*)
    \s+
    ([A-Za-z_]\w*)
    \s*\(
       ([^)]*)
    \)
    """#)

    // MARK: - C++ (leading-return + trailing-return)

    nonisolated(unsafe) static let cppVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:extern|static|register|thread_local)?\s*
    (?:constexpr\s+|const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+|typename\s+)*
    ([A-Za-z_][A-Za-z0-9_:]*
     (?:<[^>]+>)?
    )
    (?:\s*[\*&]+)?
    \s+([A-Za-z_]\w*)
    """#)

    nonisolated(unsafe) static let cppFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:template\s*<[^>]*>\s*)?
    (?:inline\s+|static\s+|virtual\s+|constexpr\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|typename\s+|friend\s+)*
    ([A-Za-z_][A-Za-z0-9_:<>\*\&]+)
    \s+
    ([A-Za-z_][A-Za-z0-9_:]*)
    \s*\(
       ([^)]*)
    \)
    """#)

    nonisolated(unsafe) static let cppConstructorRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^\s*
    (?:template\s*<[^>]*>\s*)?
    (?:inline\s+|explicit\s+|constexpr\s+|consteval\s+|constinit\s+|friend\s+)*
    ([A-Za-z_][A-Za-z0-9_:<>]*)
    \s*\(
       ([^)]*)
    \)
    """#)

    nonisolated(unsafe) static let cppTrailingReturnFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:template\s*<[^>]*>\s*)?
    (?:inline\s+|static\s+|virtual\s+|constexpr\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|typename\s+|friend\s+)*
    auto
    \s+
    ([A-Za-z_][A-Za-z0-9_:]*)
    \s*\(
       ([^)]*)
    \)
    \s*->\s*
    ([A-Za-z_][A-Za-z0-9_:\?<>\*\&]+)
    """#)

    // MARK: - Python

    /// Python variable: `name: Type`
    /// Output: (wholeMatch, varName, typeName)
    nonisolated(unsafe) static let pythonVariableRegex: Regex<(Substring, Substring, Substring)> =
        #/^([A-Za-z_]\w*)\s*:\s*([A-Za-z_][A-Za-z0-9_\.\[\]\|]*)/#

    /// Python function: `(async )?def name(params)( -> returnType)?:`
    /// Output: (wholeMatch, funcName, paramList, returnType?)
    nonisolated(unsafe) static let pythonFunctionRegex: Regex<(Substring, Substring, Substring, Substring?)> =
        #/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)(?:\s*->\s*([A-Za-z_][A-Za-z0-9_\.\[\]\|\,\(\)\{\}\s]*))?\s*:.*$/#

    // MARK: - JavaScript/TypeScript (basic patterns)

    /// JS/TS variable: `(var|let|const) name?: Type`
    /// Output: (wholeMatch, varName, typeName?)
    static let jsTsVariableRegex = CodeMapPCRE2Pattern(#"^[ \t]*(?:var|let|const)\s+([A-Za-z_]\w*\??)\s*(?::\s*([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?"#)

    /// JS/TS function: `(export)? (default)? (async)? function name<T>?(params): ReturnType?`
    /// Output: (wholeMatch, funcName, paramList, returnType?)
    static let jsTsFunctionRegex = CodeMapPCRE2Pattern(#"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*\??)(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?(?:\s*\{)?"#)

    /// TS arrow function pattern
    static let tsArrowFunctionRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?(?:async\s+)?
    (?:var|let|const)\s+
    ([A-Za-z_]\w*\??)
    (?:\s*:\s*
       (?:<[^>]+>\s*)?
       \([^)]*\)\s*=>\s*
       ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*)
    )?
    \s*=\s*
    \(?[^)]*\)?\s*=>     # actual arrow
    (?:\s*\{)?
    """#)

    /// TS arrow function with params and return: `const name = (params): ReturnType =>`
    /// Output: (wholeMatch, funcName, paramList, returnType)
    static let tsArrowFunctionParamsReturnRegex = CodeMapPCRE2Pattern(#"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:var|let|const)\s+([A-Za-z_]\w*\??)\s*=\s*\(([^)]*)\)\s*:\s*([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-\s,]*)\s*=>"#)

    /// TS type alias: `(export)? type Name = Type`
    /// Output: (wholeMatch, aliasName, rhsType)
    static let tsTypeAliasRegex = CodeMapPCRE2Pattern(#"^[ \t]*(?:export\s+)?(?:default\s+)?type\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*)"#)

    /// TS variable: `(export)? (var|let|const) name?: Type`
    /// Output: (wholeMatch, varName, typeName?)
    static let tsVariableRegex = CodeMapPCRE2Pattern(#"^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:var|let|const)\s+([A-Za-z_]\w*\??)(?:\s*:\s*([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?"#)

    // MARK: - TSX

    /// Very similar to TS but we allow a generic in the name, e.g. "function FooComponent<T>()"
    static let tsxVariableRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?(?:async\s+)?
    (?:var|let|const)\s+
    ([A-Za-z_]\w*(?:<[^>]*>)?\??)
    (?:\s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?
    """#)

    static let tsxFunctionRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?(?:async\s+)?
    function\s+
    ([A-Za-z_]\w*(?:<[^>]*>)?\??)
    \s*\(
       ([^)]*)
    \)
    (?:\s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?
    (?:\s*\{)?
    """#)

    static let tsxArrowFunctionRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?(?:async\s+)?
    (?:var|let|const)\s+
    ([A-Za-z_]\w*(?:<[^>]*>)?\??)
    (?:\s*:\s*
       (?:<[^>]+>\s*)?
       \([^)]*\)\s*=>\s*
       ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*)
    )?
    \s*=\s*
    \(?[^)]*\)?\s*=>     # arrow
    (?:\s*\{)?
    """#)

    // MARK: - TS class-level methods / properties

    static let tsClassMethodRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?
    (?:(?:public|private|protected|static|readonly|abstract|async|override)\s+)*
    ([A-Za-z_]\w*\??)
    \s*\(
       ([^)]*)
    \)
    (?:\s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?
    (?:\s*\{)?
    """#)

    static let tsClassPropertyRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?
    (?:(?:public|private|protected|static|readonly|const)\s+)*
    ([A-Za-z_]\w*\??)
    \s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*)
    """#)

    static let tsClassArrowMethodRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?
    (?:(?:public|private|protected|static|readonly|abstract|async)\s+)*
    ([A-Za-z_]\w*\??)
    \s*=\s*\(
       ([^)]*)
    \)
    (?:\s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?
    \s*=>
    (?:\s*\{)?
    """#)

    static let tsClassArrowNoParensRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?
    (?:(?:public|private|protected|static|readonly|abstract|async)\s+)*
    ([A-Za-z_]\w*\??)
    \s*=\s*
    ([A-Za-z_]\w*)
    \s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*)
    \s*=>
    (?:\s*\{)?
    """#)

    static let tsConstructorRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:(?:public|private|protected)\s+)?
    constructor\s*\(
       ([^)]*)
    \)
    (?:\s*\{)?
    """#)

    static let tsAccessorRegex = CodeMapPCRE2Pattern(#"""
    (?xm)
    ^[ \t]*
    (?:export\s+)?(?:default\s+)?
    (?:(?:public|private|protected|static)\s+)*
    (get|set)\s+
    ([A-Za-z_]\w*\??)
    (?:\s*\(([^)]*)\))?
    (?:\s*:\s*
    ([A-Za-z_][A-Za-z0-9_<>\|\[\]\(\)\{\}\&\?\.\-]*))?
    (?:\s*\{)?
    """#)

    // MARK: - Go

    nonisolated(unsafe) static let goVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:var|const)\s+
    ([A-Za-z_]\w*)
    (?:
    	\s+([A-Za-z_][A-Za-z0-9_\.\*\[\]]*)  # optional explicit type
    )?
    (?:\s*=\s*[^;]+)?
    """#)

    nonisolated(unsafe) static let goFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    func\s+
    (?:\([^)]*\)\s+)?        # optional receiver
    ([A-Za-z_]\w*)
    \s*\(
       ([^)]*)
    \)
    \s*
    (
     \([^\)]*\)
     |
     [A-Za-z_][A-Za-z0-9_\.\*\[\]]*
    )?
    """#)

    // MARK: - Rust

    nonisolated(unsafe) static let rustVariableRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    let\s+(?:mut\s+)?
    ([A-Za-z_]\w*)
    (?:
    	\s*:\s*([A-Za-z_][A-Za-z0-9_<>:\?\*\&]+)
    )?
    (?:\s*=\s*[^;]+)?
    """#)

    nonisolated(unsafe) static let rustFunctionRegex: Regex<AnyRegexOutput> = try! Regex(#"""
    (?xm)
    ^
    (?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?
    fn\s+
    ([A-Za-z_]\w*)             # group(1): function name
    \s*\(
       ([^)]*)                 # group(2): param list
    \)
    (?:\s*->\s*
       ([A-Za-z_][A-Za-z0-9_:\&]*)
    )?
    \s*\{?
    .*$
    """#)

}
