# Discovery prompt source and bindings

`prompts/discovery-v1.md` uses RepoPrompt CE's discovery wording and section order. `prompts/reference/rpce-discovery.md` is the rendered reference for comparing changes. Discovery uses the supplied numeric token budget; recipient compatibility is checked separately when delivering the finished packet.

## Reference rendering

The reference was rendered from `Sources/RepoPrompt/Infrastructure/AI/SystemPromptService.swift` at RPCE commit `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`, Git blob `4943690a86bf880ce9f5cb085e2e4f57211175e5`. The renderer executed the source's `discoverPrompt`, `mcpDiscoverPrompt` and supporting review-guidance functions with these inputs:

- `tokenBudget: 200000`, an illustrative rendering parameter; smip jobs obtain their budget from `initialContext.measurement.allowance`.
- `agentKind: .codexExec`, for the restricted-tool workflow.
- `enhancementMode: .fullRewrite`, the default mode for composing the MCP handoff.
- `allowClarifyingQuestions: false`, the MCP default.
- `responseType: "review"`, with no restricted-review target or extra instructions. The static smip prompt applies this section when `Assignment.purpose` is `review`.
- `__SUPPORTED_LANGUAGES__` as a placeholder for the catalog of supported languages at runtime. Smip reports structural coverage through `get_code_structure` results.

Only external type/default/catalog definitions were supplied by the rendering harness; the prompt factory's policy text and branching were executed unchanged. The reference file retains the rendered punctuation and whitespace. The smip prompt uses spaced hyphens for em-dash punctuation.

The native `renderDiscoveryPrompt` operation executes the extracted RPCE factory in `native/Sources/SmipBridge/RPCEContextBuilderPrompt.swift`. It takes an explicit budget, runtime, enhancement mode, review inputs and clarification settings, and returns the complete reference prompt. The language catalog comes from the retained native syntax engine. `test/fixtures/rpce-discovery/` contains source-rendered outputs for Rewrite, Augment and Preserve with an explicit catalog placeholder; the test normalizes only that catalog line.

RPCE supplies the configured budget after its host-side 1500-unit reserve. Smip's initial context supplies the already admitted complete-packet allowance. The prompt reads that number rather than deriving a budget from a receiving model.

## Native bindings

Every substantive difference belongs to one of these interface bindings. Discovery principles, selection priority, refinement order, slice guidance, emphasis, repetitions and anti-patterns otherwise retain the reference wording.

| Binding | Native representation | Reason |
| --- | --- | --- |
| Version and attribution | `# smip discovery v1` and the RPCE revision/license footer | `PiRunner` requires the version marker; attribution identifies the source. |
| Captured state and assignment | `initialContext`, `Assignment.task`, `Assignment.constraints`, `Assignment.enhancementMode` and `Assignment.hints` | These are the actual scout inputs. The original request is retained as provenance; the resulting literal prompt is mutable. |
| Numeric budget | “The supplied token budget,” bound to `initialContext.measurement.allowance` | A static editable prompt serves jobs with different admitted budgets. |
| Tools and paths | The seven smip tools, explicitly configured HTTP MCP tools, and separate `root`/`path` fields | Built-in shell and filesystem tools are unavailable. Smip workspace tools enforce root policy; HTTP MCP tools have separately authorized capabilities. |
| Selection and cost inspection | `draft_inspect` metadata/costs with response caps and continuations | These views provide current representations and complete-packet measurements. |
| Source selection | One `draft_update` upsert/remove per file; `clearSources` restores the required baseline | Smip has no directory selection or multi-file mutation. Required inputs remain fixed. |
| Codemap operations | `clearCodemaps`, codemap upserts and full/slice promotion | Codemap upserts enter manual mode; full/slice upserts preserve mode. RP's prompt says promotion disables automation, but neither implementation does. |
| Prompt operations | `prompt` with get, set, append and clear; revision and response-cap fields for mutations | Literal prompt state supports Rewrite, Augment and Preserve; the resulting text is delivered in `user_instructions`. |
| Tab naming | Task-name metadata is omitted | Smip has no compose tab to rename. |
| Review evidence | Inspect the admitted patches and select supporting source | Git comparison acquisition belongs to the caller. Admitted patches are immutable and cannot be sliced. |
| Slice preview | `read_file` before a slice upsert | There is no `manage_selection.preview` operation. |
| Final gate and settlement | `draft_validate`, followed by an acknowledgement; parent-owned verification/publication | The scout stores its handoff and selection; its final response is not the published packet. |
| Unattainable required budget | Preserve required material, record the gap and return a blocking diagnostic | Immutable caller inputs can make the budget impossible; the scout cannot remove them to force success. |
| Native tool constraints | Revisions, continuations, pinned-source recovery and complete MCP documents | These contracts are needed to operate the native tools and preserve the authority of the original assignment. |

The reference's approximate auto-codemap overhead guidance remains guidance followed by actual cost inspection. Its strict "must exceed" wording and non-strict `>=` checklist are both retained; neither introduces a runtime representation-ratio check.

## Checking edits

Compare the complete files, rather than checking whether a summary mentions the same concepts:

```sh
git diff --no-index -- prompts/reference/rpce-discovery.md prompts/discovery-v1.md
```

Each changed span should correspond to a binding above. A policy change needs a source-backed reason and an explicit decision. Rephrasing, shortening or reorganizing the reference requires that same decision. The reference is a comparison artifact, while `scripts/build-resources.mjs` packages the native prompt used by discovery jobs.
