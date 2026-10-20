// Derived from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3.
// Modified: isolate root authority construction from filesystem acquisition.
import Foundation

enum IgnoreRootRules {
    struct CompiledRootAuthority {
        let gitignore: CompiledIgnoreRules?
        let global: CompiledIgnoreRules
        let repoIgnore: CompiledIgnoreRules?
        let cursorignore: CompiledIgnoreRules?
    }

    nonisolated static func compileRootAuthority(
        gitignoreContent: String?,
        globalIgnoreContent: String,
        repoIgnoreContent: String?,
        cursorignoreContent: String?
    ) -> CompiledRootAuthority {
        CompiledRootAuthority(
            gitignore: gitignoreContent.map { GitignoreCompiler.compile(content: $0) },
            global: GitignoreCompiler.compile(content: globalIgnoreContent),
            repoIgnore: repoIgnoreContent.map { GitignoreCompiler.compile(content: $0) },
            cursorignore: cursorignoreContent.map { GitignoreCompiler.compile(content: $0) }
        )
    }

    /// Builds the authoritative ordinary-crawl root chain. For Git roots, Git's
    /// own ignore chain is a mandatory floor: global/app controls may add
    /// exclusions but their negations cannot re-include a Git-ignored path.
    /// Non-Git callers retain the historical single-chain precedence.
    nonisolated static func makeRootRules(
        authority: CompiledRootAuthority,
        respectRepoIgnore: Bool,
        respectCursorignore: Bool,
        policy: IgnoreRulePolicy
    ) -> IgnoreRules {
        let rules = IgnoreRules(policy: policy)
        if let gitignore = authority.gitignore {
            rules.addCompiledLayer(gitignore, authority: .mandatoryGit)
        }
        rules.addCompiledLayer(authority.global, authority: .secondary)
        if respectRepoIgnore, let repoIgnore = authority.repoIgnore {
            rules.addCompiledLayer(repoIgnore, authority: .secondary)
        }
        if respectCursorignore, let cursorignore = authority.cursorignore {
            rules.addCompiledLayer(cursorignore, authority: .secondary)
        }
        return rules
    }
}
