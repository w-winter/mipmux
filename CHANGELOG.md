# Changelog

## [Unreleased]

## [0.1.0-alpha.8] - 2026-11-20

### Fixed
- `mipmux models` and Pi-based discovery now read Pi's saved model catalogs. After refreshing the catalogs with `/scoped-models` in Pi, newly available models show up in mipmux.
- Local Git patches now include deleted symlinks in commit, staged and worktree comparisons. The patch shows each link's stored target without following it. These deletions previously stopped context builds with `unsupportedComparisonEntry`.

## [0.1.0-alpha.7] - 2026-11-18

### Changed
- The README quickstart runs mipmux through `npx`, with no global installation. Install mipmux globally when you use the Pi or omp extensions or Claude Code discovery, which need a `mipmux` command on your PATH.
- The automatic Git diff in a Review packet labels its sections `MIPMUX CHECKOUT DIFF` and `MIPMUX REVIEW DIFF INCOMPLETE`, and file search reports `mipmux path` as the engine for path-only queries. Review packets saved by earlier versions with these sections fail `mipmux verify` and `context_prepare`; build them again.
- The PCRE2 settings for the native helper are `MIPMUX_PCRE2_JIT` and `MIPMUX_PCRE2_MATCH_LIMITS`. Rename `REPOPROMPT_PCRE2_JIT` and `REPOPROMPT_PCRE2_MATCH_LIMITS` in `nativeEnvironment`.
- The shipped discovery prompt describes `<current_prompt_content>` as the draft's prompt when discovery starts. A copy at `discovery.promptTemplatePath` keeps its earlier wording until you replace it.

### Fixed
- Preparing a Review or Diff Follow-Up packet with `context_prepare`, or checking it with `mipmux verify --mode current`, no longer fails with `automaticGitChanged` when nothing has changed. This happened when the packet's automatic Git diff listed more than one path diagnostic, such as `No owning repository` for selected files outside any Git repository, because mipmux recorded those diagnostics in selection order and the order it reconstructed from the saved packet could differ. Diagnostics now follow a fixed order. A packet saved by an earlier version can still fail this way until it is built again.

## [0.1.0-alpha.6] - 2026-11-13

### Highlights
- Publishing a packet from a large workspace takes seconds instead of minutes.
- Discovery stops at the first response from the wrong model, instead of after the whole run.
- Self-hosted model endpoints can declare the model name they serve.

### Added
- Self-hosted OpenAI chat-completions endpoints can declare the model name they report with `modelOverrides.<model>.expectedServerModel` in the models file. Responses must report that name, although failed or aborted responses may omit it. A successful response with no name fails with `modelIdentityUnavailable`.

### Changed
- The plan and review skills in `workflow-examples/` have the coordinating agent compare each file-backed document in a prepared packet with its file's SHA-256 before dispatching the packet.

### Fixed
- Publishing a packet from a large workspace takes seconds instead of minutes. mipmux now reads native request and reply frames in linear time. In a synthetic workspace of 10,720 files, publishing took about 2 seconds instead of 337. Thanks to [@lionrooter](https://github.com/lionrooter) for reporting #1.
- Discovery stops after the first response that reports an unexpected model and fails with `modelIdentityMismatch`, and the failed job's receipt records the reported identity. Before, the mismatch appeared only after discovery had finished, as `incompleteDiscoveryReceipt`. Thanks to [@lionrooter](https://github.com/lionrooter) for reporting #2.

### Security
- Updated the bundled transitive dependencies `hono` from 4.13.14 to 4.13.16 and `@hono/node-server` from 2.1.5 to 2.1.6 to address security advisories.

## [0.1.0-alpha.5] - 2026-11-06

### Changed
- Anthropic now sees mipmux as the client in Claude Code discovery requests. mipmux sets `CLAUDE_CODE_ENTRYPOINT=mipmux` for Claude Code, which otherwise reports the Agent SDK's default, `sdk-ts`.

## [0.1.0-alpha.4] - 2026-11-05

### Fixed
- Rebuilding a packet with `context_prepare` keeps the documents that discovery added. Before, a rebuild, such as one that added another document, kept only the documents from the original build request.

## [0.1.0-alpha.3] - 2026-11-04

### Added
- Multi-agent workflow examples in `workflow-examples/` for Claude Code, Codex, omp, pi-interactive-subagents and pi-subagents. Each setup defines a planner, a plan critic and a reviewer, with plan and review skills that build a packet with mipmux and dispatch it to those agents. Each README names the client versions the examples ran on.

### Changed
- The README and release guide describe installing mipmux from npm or a release archive, with building from source as the alternative.
- The agent workflow in `docs/workflow.md` tells the coordinating agent to hand off a packet at the size the user's budget sets, instead of checking it against the recipient's context window.

## [0.1.0-alpha.2] - 2026-11-03

### Highlights
- First published release of mipmux, a headless port of RepoPrompt CE's Context Builder.
- Build a context packet from any MCP client with three tools: `context_builder`, `context_job` and `context_prepare`.
- A discovery agent picks the files, slices, code maps, Git patches and documents a task needs, within your token budget.
- Saved packets record their sources, and `context_prepare` refuses a packet whose sources changed since discovery.
- Install from npm on macOS arm64, Linux x64 and Linux arm64.

### Added
- An MCP server over stdio. By default it offers three tools. `context_builder` starts a build. `context_job` waits for the build's job, sends answers to its clarification questions, and cancels or disposes of it. `context_prepare` publishes a saved packet with its final task and makes no model call. It refuses a packet whose sources changed, or rebuilds it from current files on request or when inputs are added, removed or demoted. Setting `tools` to `"full"` adds workspace, exploration and manual-packet tools.
- Discovery runs through Pi's agent SDK with a provider login or API key, or through Claude Code with the optional Claude Agent SDK. A build can choose its model and thinking level from the models the configuration allows, and discovery can call allowlisted tools on configured HTTP MCP servers. Job receipts record token usage and the model's tool calls.
- Packets for planning, review and investigation tasks, each saved as a bundle of `context.md`, `manifest.json` and `handoff.md`. mipmux checks a bundle from its own bytes or against the current files. The Standard, Review, Diff Follow-Up and Manual copy presets, and custom presets, control what a packet includes. Review adds the Git diff of the selected files.
- Workspace indexing that follows RepoPrompt CE's ignore rules, Git's ignore and exclude files, and `.mipmux_ignore` files in any folder.
- A `mipmux` command with the subcommands `mcp`, `config`, `models`, `workspace`, `tool`, `build`, `render`, `verify` and `cache invalidate`, and a TypeScript library.
- npm packages and attested release archives for macOS arm64, Linux x64 and Linux arm64. The `mipmux` package installs its native helper from the matching `@w-winter/mipmux-<platform>-<arch>` package.

### Fixed
- Every build emits the same TypeScript declarations, so release packaging, which compares the builds from each platform, succeeds. The `v0.1.0-alpha.1` tag never became a release because these declarations differed between platforms.
