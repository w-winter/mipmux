# Discovery prompt source and bindings

`prompts/discovery-v1.md` uses RepoPrompt CE's discovery wording and section order. `prompts/reference/rpce-discovery.md` is the rendered reference for comparing changes. Discovery uses the supplied numeric token budget; recipient compatibility is checked separately when delivering the finished packet.

## Reference rendering

The reference was rendered from `Sources/RepoPrompt/Infrastructure/AI/SystemPromptService.swift` at RPCE commit `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`, Git blob `4943690a86bf880ce9f5cb085e2e4f57211175e5`. The renderer executed the source's `discoverPrompt`, `mcpDiscoverPrompt` and supporting review-guidance functions with these inputs:

- `tokenBudget: 200000`, an illustrative rendering parameter; smip jobs supply `Assignment.tokenBudget` after the 1500-unit startup reserve.
- `agentKind: .codexExec`, for the restricted-tool workflow.
- `enhancementMode: .fullRewrite`, the default mode for composing the MCP handoff.
- `allowClarifyingQuestions: false`, the MCP default.
- `responseType: "review"`, with no restricted-review target or extra instructions. The static smip prompt applies this section when `Assignment.purpose` is `review`.
- `__SUPPORTED_LANGUAGES__` as a placeholder for the catalog of supported languages at runtime. Smip reports structural coverage through `get_code_structure` results.

Only external type/default/catalog definitions were supplied by the rendering harness; the prompt factory's policy text and branching were executed unchanged. The reference file retains the rendered punctuation and whitespace. The smip prompt uses spaced hyphens for em-dash punctuation.

The native `renderDiscoveryPrompt` operation executes the extracted RPCE factory in `native/Sources/SmipBridge/RPCEContextBuilderPrompt.swift`. It takes an explicit budget, runtime, enhancement mode, review inputs and clarification settings, and returns the complete reference prompt. The language catalog comes from the retained native syntax engine. `test/fixtures/rpce-discovery/` contains source-rendered outputs for Rewrite, Augment and Preserve with an explicit catalog placeholder; the test normalizes only that catalog line.

The native `renderDiscoveryMessage` operation uses `ContextBuilderAgentViewModel.makeUserMessage` and the selected-meta-prompt formatting from `ContextBuilderPromptsOverlay.swift` at the same reference revision. Its inputs are the file tree, current prompt, discovery instructions, ordered selected meta prompts and adjusted budget. The renderer includes these sections in the source order. Startup guidance describes full content, slices and codemaps according to each selected representation; the source sentence claiming automatic compression is replaced. `test/fixtures/rpce-discovery-message/` contains six outputs generated from the original Swift functions; `scripts/generate-discovery-message-fixtures.mjs` regenerates them from a checked reference checkout. The test permits only that sentence correction when comparing the complete message. This operation is a source-rendering boundary; the current Pi dispatch still uses the captured context and Assignment JSON.

RPCE supplies the configured budget after its host-side 1500-unit reserve. Smip supplies `max(0, request.budgetUnits - 1500)` as `DiscoveryInput.tokenBudget`; complete-packet measurement uses `request.budgetUnits`. The prompt reads the scout budget rather than deriving a budget from a receiving model.

## Native bindings

Every substantive difference belongs to one of these interface bindings. Discovery principles, selection priority, refinement order, slice guidance, emphasis, repetitions and anti-patterns otherwise retain the reference wording.

| Binding | Native representation | Reason |
| --- | --- | --- |
| Version and attribution | `# smip discovery v1` and the RPCE revision/license footer | `PiRunner` requires the version marker; attribution identifies the source. |
| Captured state and assignment | `initialContext`, `Assignment.task`, `Assignment.constraints`, `Assignment.enhancementMode` and `Assignment.hints` | These are the actual scout inputs. The original request is retained as provenance; the resulting literal prompt is mutable. |
| Numeric budget | “The supplied token budget,” bound to `Assignment.tokenBudget` | A static editable prompt serves jobs with different admitted budgets. |
| Tools and paths | Smip's exposed context tools, explicitly configured HTTP MCP tools, and separate `root`/`path` fields | Built-in shell and filesystem tools are unavailable. Smip workspace tools enforce root policy; HTTP MCP tools have separately authorized capabilities. |
| File trees | Startup and tool trees share the native RPCE snapshot renderer; `scope` for root/directory selection and `maxDepth` for folder depth | The renderer retains mode, ordering, depth, selected-descendant, automatic-budget and marker behavior. Startup trees include the source legends; tool output paging preserves complete rendered lines. A plus marks an available codemap. |
| Structural queries | Native RPCE traversal, semantic size limits, signature admission, DTO and text formatter; root-qualified file/directory seeds or captured full/sliced selection | Captured inventory supplies immutable adjacency and classified outcomes. Headless roots/files use stable UUID identities; desktop graph demand coordination is replaced by retained artifacts. Seed resolution retains source direct-file priority, physical-path deduplication and its 8192-plus-sentinel bound. |
| Selection and cost inspection | `draft_inspect` metadata/costs with response caps and continuations; `draft_preview` for a prepared candidate | Inspection describes committed state. Preview returns candidate metadata, costs and diagnostics at the unchanged revision. |
| Source selection | `draft_update` source edits or an ordered atomic `batch`; `clearSources` restores the required baseline | One draft transaction owns preparation, inference from the final candidate and receipt admission. Required inputs remain fixed. |
| Codemap operations | `clearCodemaps`, codemap upserts and full/slice promotion | Codemap upserts enter manual mode; full/slice upserts preserve mode. RP's prompt says promotion disables automation, but neither implementation does. |
| Prompt operations | `prompt` with get, set, append and clear; revision and response-cap fields for mutations | Literal prompt state supports Rewrite, Augment and Preserve; the resulting text is delivered in `user_instructions`. |
| Tab naming | Task-name metadata is omitted | Smip has no compose tab to rename. |
| Review evidence | Inspect the admitted patches and select supporting source | Git comparison acquisition belongs to the caller. Admitted patches are immutable and cannot be sliced. |
| Slice preview | `manage_selection` with `op: "preview"` | Native selection policies resolve files, folders and slices; the prepared reply is admitted without committing selection. Strict preview requires rendered files or slices. |
| Final gate and settlement | `draft_validate`, followed by an acknowledgement; parent-owned verification/publication | The scout stores its handoff and selection; its final response is not the published packet. |
| Unattainable required budget | Preserve required material, record the gap and return a blocking diagnostic | Immutable caller inputs can make the budget impossible; the scout cannot remove them to force success. |
| Native tool constraints | Revisions, continuations, pinned-source recovery and complete MCP documents | These contracts are needed to operate the native tools and preserve the authority of the original assignment. |

The reference's approximate auto-codemap overhead guidance remains guidance followed by actual cost inspection. Its strict "must exceed" wording and non-strict `>=` checklist are both retained; neither introduces a runtime representation-ratio check.

## Selection transition reference

The native `transitionSelection` operation runs RPCE's `mutatePreResolvedFullFilePaths` and `setPreResolvedFilePaths` over captured canonical selection state. The first operation is the authorized full-file path used for Git artifacts; it is distinct from ordinary file addition. The second selects one exclusive representation and retains the source's automatic-mode effects. `test/fixtures/rpce-selection-transitions/` contains 13 outputs generated from the original methods, and `scripts/generate-selection-transition-fixtures.mjs` regenerates them from a checked reference checkout. Path resolution, folder expansion, ordinary add and scout-facing batch calls are separate integration responsibilities.

The native `calculateSliceRanges` operation executes RPCE's `SliceRangeMath` functions. `draft_update` uses them for file-scoped slice addition, replacement and subtraction. The draft retains full selection when its last slice is removed, matching `WorkspaceSelectionMutationService.mutateSlices`. `test/fixtures/rpce-slice-ranges/` contains seven original-source outputs; `scripts/generate-slice-range-fixtures.mjs` regenerates them. Public MCP tests cover merged descriptions, subtraction fragments, full-content restoration, failed range/receipt admission and cancellation.

## Path matching reference

The native `matchSelectionPath` operation executes RPCE's ordinary `PathMatcher.locate` kernel with the `mcpSelection` profile, frozen file/folder records, source character folding and source indexes. The profile excludes selected-file/root bias. `test/fixtures/rpce-path-match/` contains 20 outputs generated by compiling the original source; `scripts/generate-path-match-fixtures.mjs` regenerates them from a checked reference checkout. The kernel returns a root path and stored relative path or absence. Selection authorization, exact-root ambiguity checks, directory expansion and explicit file acquisition belong to their caller boundaries.

## Checking edits

Compare the complete files, rather than checking whether a summary mentions the same concepts:

```sh
git diff --no-index -- prompts/reference/rpce-discovery.md prompts/discovery-v1.md
```

Each changed span should correspond to a binding above. A policy change needs a source-backed reason and an explicit decision. Rephrasing, shortening or reorganizing the reference requires that same decision. The reference is a comparison artifact, while `scripts/build-resources.mjs` packages the native prompt used by discovery jobs.

## Captured selection candidates

The native `resolveSelectionCandidates` operation runs RPCE's ordinary full and codemap candidate rules against a caller-scoped catalog. It preserves input order, standardized absolute-path deduplication, recursively sorted directory members, empty-folder removal, root-alias ambiguity and source diagnostic text. Codemap eligibility uses the retained extension catalog rather than artifact readiness.

Exact lookup includes managed-only records. Fuzzy lookup and directory expansion use discoverable records. A missing absolute catalog path requires a captured explicit-acquisition outcome; the native operation does not infer filesystem access from the matching result. The source fixtures execute the original resolver, alias, diagnostic and lookup bodies with the shared captured-catalog adapter. Their scope and remaining filesystem/tool-boundary checks are recorded in `test/fixtures/rpce-selection-candidates/provenance.json`.

The native `mutateSelectionPaths` operation applies the ordinary add, remove, promote and demote methods to canonical captured selection and catalog state. Full add retains slices; promotion removes them. Full removal retains manual codemaps, and codemap-only removal retains full/sliced selection. Codemap add and demotion disable automatic mode only when supported candidates exist. Results retain the source diagnostics, mutation flag and operation-specific resolution/count fields. `test/fixtures/rpce-selection-path-mutations/` contains the source-derived transitions. The candidate-fixture generator regenerates both ordinary candidate and mutation cases.

`prepareSelection` retains RPCE's whole-selection replacement and file-scoped slice replacement, including the full-file artifact flag that selects replacement scope. Batch slice add/set/setPaths/remove uses the source normalization, coalescing and subtraction rules. `parseSelectionInputs` retains terminal `#L` recognition, numeric/string range aliases, description precedence and parser diagnostics through the pinned SDK JSON decoder. Source-generated cases are in `test/fixtures/rpce-selection-preparation/` and `test/fixtures/rpce-selection-input-parsing/`.

The public `manage_selection` adapter calls those native policies inside the existing draft transaction. `selectionPathBindings` applies the original Foundation path normalization before catalog construction; captured physical-root identities remain the confinement authority. This separates Darwin's equivalent `/var` and `/private/var` spellings from native selection display keys. Explicit file registration belongs to the loaded workspace and commits before extraction/selection completion, matching the reference's separation between catalog and selection persistence. `test/manage-selection.test.ts` exercises the real MCP operations, saved packet evidence, rejected-set registration retention, post-registration cancellation, refresh and non-acquiring get/clear behavior.

## Git command binding

`RPCEGitLog.swift` and `RPCEGitBlame.swift` retain command construction and stdout parsing from `GitService.swift` at revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. `src/exploration/git.ts` binds the declared root and path to the existing supervised Git process. The source-derived command and DTO cases are in `test/fixtures/rpce-git-read/`.

Blame adds `--no-textconv` to the reference command. Repository text converters are executable programs; allowing them would let a read query run a configured script. The public MCP regression configures such a converter and checks both the returned attribution and the absence of the marker written by that script. This is a named security binding, not command-argument equality with the unmodified reference. Log already disables external diff and text conversion in the source command.

Status retains the original `GitStatusPorcelainV2Parser`, record types and `MCPGitToolProvider.makeStatusDTO`. The source command supplies branch headers and NUL-delimited paths in one observation. The native formatter consumes that snapshot directly, with the source DTO's omission of absent tracking fields. Fourteen original-source cases cover tracking, renames/copies, submodules, conflicts, unborn/detached heads, unusual paths and malformed records. `scripts/generate-git-status-fixtures.mjs` regenerates `test/fixtures/rpce-git-status/`. The public MCP case checks mixed staged/worktree/untracked state, a root below its checkout, unchanged index bytes and a disabled filesystem-monitor hook. Repository routing metadata is the existing root-qualified headless binding; source worktree warnings and multi-repository presentation remain separate unfinished port responsibilities.

Git's clean/process filters participate in canonical worktree-to-index comparisons and can execute repository-local programs during status. Those programs run with the Git process's OS permissions, so the repository's Git configuration must be trusted.

Show retains the source commit metadata parser, tracked diff-stat parsers, rename normalization, path ordering and `MCPGitToolProjection.makeShowDTO`. Metadata is parsed before requesting diff statistics or hunks. The source `<ref>^!` comparison remains intact, including its root-commit worktree behavior. The existing safe resolver captures the commit ID before constructing commands, preventing option-shaped references from becoming Git options. Diff commands add `--no-textconv` for the same converter-execution restriction as blame. `test/fixtures/rpce-git-show/` contains eight outputs generated from the original metadata, stat and projection functions. `scripts/generate-git-show-fixtures.mjs` regenerates them. Public MCP cases cover detail modes, complete hunks, output-budget rejection, invalid references, malformed metadata and cancellation between command phases. The scripted scout invokes show through Pi's SDK and its allowed tools.

## Native Git patch parsing

`parseGitPatch` is the native data-only boundary for RPCE's `GitService.splitUnifiedDiffByFile` and `GitDiffPatchParsing`. It returns complete per-file patch bodies, parsed hunk ranges/content, change counts and the source changed-line TSV. The source algorithms retain header-prefix handling, handling of quoted and octal-escaped paths, malformed-hunk behavior and line endings. `test/fixtures/rpce-git-patch/` contains eleven outputs generated by compiling the original source; `scripts/generate-git-patch-fixtures.mjs` regenerates them. This boundary supplies patch parsing for the native Git projections.

Literal LF splitting in `GitDiffPatchParsing` calls `NSString` on both platforms. Linux Swift's `String.components(separatedBy:)` treats CRLF differently from Darwin Foundation; `NSString.components(separatedBy:)` reproduces the original Darwin output. Patch bytes and line endings remain intact. The file splitter keeps its original Swift `String.split` behavior.

## Native diff comparison and projection

`parseGitComparison` returns RPCE's typed comparison with its display string and raw key. It includes uncommitted, staged, unstaged, merge-base and revision-specification forms, including the source defaults and `back:` expansion. The native dependency encodes the current comparison shape; its inputs are raw comparison strings.

`projectGitDiff` consumes captured changed-file records and per-file patches. It uses the source diff DTO, status totals, summary text and hunk-aware truncation. Summary detail upgrades to patches for one path in one repository. Patches use the source 300-line allowance; full detail retains complete hunks. Binary counts, empty patch dictionaries and omitted hunks follow the source projection. Git projections use the closed `GitOperation` enum in the native dispatcher, matching the existing selection-operation grouping.

`test/fixtures/rpce-git-diff/` contains 32 outputs generated from the original comparison, provider-policy and projection functions. `scripts/generate-git-diff-fixtures.mjs` regenerates them. These fixtures supply captured inputs to the native policy; repository resolution, acquisition and selected-artifact behavior require their own integration evidence.

## Native ignore-policy snapshots

`queryIgnoreRules` compiles captured Git, global, repository and cursor ignore controls into the original RPCE rule snapshot. Git-root policy retains the mandatory Git floor; secondary negations can override secondary rules. Non-Git roots use the source ordered layers. Repository-relative prefixes and scoped child layers use the original matching rules, including their negation traversal hints.

The native implementation retains the original C wildcard matcher, Swift compiler, immutable rule nodes and bounded pattern-string pool. `test/fixtures/rpce-ignore/` contains 20 outputs produced by compiling the original source. `scripts/generate-ignore-fixtures.mjs` regenerates them. These fixtures exercise supplied control text and query paths.

Workspace admission uses the original containing-repository resolver, Git layout resolver, global pattern defaults and hierarchical prefix evaluator. A source-root capability replaces the desktop filesystem service. Native capture reads the fixed control names and records authority, settings, text and byte identities; TypeScript retains the captured policy for the generation and current verification. On macOS, directory paths are canonicalized before no-follow traversal so Foundation's `/var` and `/private/var` spellings address the same physical parent. Mandatory Git controls keep their no-follow leaf rule. `test/workspace-ignore-parity.test.ts` exercises inherited controls, mandatory Git exclusions, negation reachability, configured layer switches, separate Git directories and current-policy change rejection through runtime operations.

## Selection reply projection

`renderSelectionReply` uses the source `buildSelectedFilesReply`, copy-preset projection and `applyViewFilter` policies from `MCPServerViewModel+SelectionCore.swift`, together with the original `ToolResultDTOs` selection and token-accounting declarations. Captured paths, root labels, ranges and token estimates replace app formatting and token-service reads. The category loops share a reply-local accumulator and retain implementation-before-codemap ordering, slice DTOs, source field names and summary/filter calculations. Native Swift emits optional fields through Codable.

`test/fixtures/rpce-selection-reply/` contains five results from compiling the original aggregation and view-filter functions independently; `scripts/generate-selection-reply-fixtures.mjs` regenerates them. The reference driver shares immutable input parsing and captured-value bindings. These cases establish DTO projection, ordering, summaries, filtering and pending/terminal diagnostic fields, not complete-packet token calculation, app copy-preset configuration or content-block packaging. Public MCP tests verify the projected selection and unchanged state after view reads. `manage_selection` commits optional codemap membership before presentation demand and native reply rendering, following `MCPSelectionToolProvider.persistAndReply`'s persistence-before-reply ordering. Held native replies verify that cancellation or rendering failure retains committed selection, and a later mutation cannot be overwritten by the earlier reply. Public reply-cap tests distinguish committed mutations from non-mutating preview.

`WorkspaceOperation.registerExplicitSource` captures confined membership before extraction. `WorkspaceRuntime.retainCodemap` binds shared demands to the captured root/path/source/structural identity, with independent retain IDs; request operations release their own IDs and join cleanup. The store-owned Swift task and ticket machinery in `WorkspaceFileContextStore.swift:14271–14502,15415–15519` is bound to smip's existing workspace and operation owners, rather than copied with its app-store dependencies. `resolveSelectedCodemaps` uses the production 10,000 ms allowance from `Presentation/WorkspaceCodemapPresentationCoordinator.swift:3–40,235–333` and awaits owned cleanup separately. Admitted shared artifact extraction follows the reference's non-preemptive build contract. Its immutable result can be persisted after observer cancellation; cancellation prevents publishing that cancelled demand into the managed catalog. Pending material is a live variant, not another manifest format. A later get reacquires presentation and updates only the still-selected captured material; publication rejects unresolved material. `test/codemap-demand.test.ts` covers shared retention, last-release cleanup, native failure/retry and runtime shutdown. Public selection tests cover post-commit cancellation, pending diagnostics at the production deadline, later get and saved verification.

This pinned headless binding uses captured identity instead of watcher tickets. Busy admission, retries after stale publication, limits on presentations and extraction requests, and remaining automatic graph demands still need conformance evidence. Full-file and slice bodies are acquired before selection persistence. This checkpoint proves explicit codemap readiness only.

## File-block formatting dependency

`renderFileBlock` executes the retained `PromptPackagingService` formatting methods and `SliceAssemblyBuilder` from the pinned reference. The native input supplies decoded whole-file text, a resolved display path, the file name and nullable ranges. Source assembly preserves line terminators, clamps ranges, merges overlapping or adjacent descriptions and produces the source full-file result when no usable slices remain. The original C ending detector is imported through the existing `RepoPromptC` target. The formatter retains source fence, label and newline behavior, including embedded NUL in file text. `WireObject.text` accepts that text as data; the path/identifier accessor retains its NUL restriction. The interactive reader uses the same raw-text accessor.

`test/fixtures/rpce-file-blocks/` contains 13 outputs generated by independently compiling the original Swift formatter, slice assembly, scalar splitter and C detector. `scripts/generate-file-block-fixtures.mjs` regenerates them. Native protocol tests compare the complete text, segments and detected ending; the public read fixture verifies NUL content through MCP. `manage_selection`'s content view invokes this native formatter for full files and slices, with the request's resolved display path. Slices recheck captured source identity, mode and decoding before assembly; codemap text uses its retained projection. Public MCP tests verify complete full-file and described-slice blocks. Final packet assembly and source accounting remain unfinished.

## Selection error hints

`selectionHint` executes the extracted `MCPServerViewModel.makeSelectionHintError` method at the pinned RPCE revision. Captured root names and physical paths replace the app store and tab projection. Absolute input paths use the retained `StandardizedPath` implementation; trimming, root order, descendant boundaries, the two-path sample and diagnostic wording follow the source. `test/fixtures/rpce-selection-hints/` contains five outputs from independently compiling the original method and path normalization; `scripts/generate-selection-hint-fixtures.mjs` regenerates them. Public MCP tests exercise strict add/remove/preview failures, invalid slice specifications, promotion/demotion and non-renderable codemap previews.

## Automatic source decoding

`RPCESourceDecoder` applies the automatic decoding order from `FileSystemService+ContentLoading.swift` at the pinned RPCE revision. The original UniversalCharsetDetection wrapper and Cuchardet detector are compiled in the native package. macOS retains the Foundation heuristic; Linux uses native conversion for detected encodings and reports detector failure explicitly. The two policies have distinct identities because the macOS heuristic can accept short Big5/GB18030 inputs the Linux policy rejects.

Inventory, reads, search, source selection, local documents and structural extraction use this decoded view. Raw source bytes retain their acquisition identity; exports and line spans use decoded UTF-8. `test/fixtures/rpce-decoding/` contains 270 original-source decoder cases. The pipeline test verifies full, slice, codemap and local-document delivery plus saved/current verification on both platforms.
