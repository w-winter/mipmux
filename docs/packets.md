# Manual context packets

A context packet is the `context.md` file that mipmux saves with a task for a planning, review or investigation model, together with the records that let mipmux check it later. Discovery usually assembles packets. This page describes how a packet is assembled from a draft, for library hosts and for MCP clients that select context themselves; the same rules govern the drafts that discovery fills. RPCE stands for RepoPrompt CE, whose Context Builder mipmux ports.

MCP clients reach drafts through the manual-packet tools `prompt`, `manage_selection`, `draft_create`, `draft_inspect`, `draft_update`, `draft_validate`, `draft_finalize` and `draft_dispose`, which the server offers when its `tools` setting is `"full"`. The examples below use the [TypeScript library](library.md).

## Selecting files

The MCP and Pi `manage_selection` tool supports get, set, add, remove, preview, promote, demote and clear operations. File and directory paths can use declared root aliases; absolute file paths also support explicit access to ignored regular files within the workspace. Managed-only files remain accessible by exact path and are excluded from ordinary discovery. Full-file additions retain existing slices, while promotion restores full content. Codemap-only additions, demotion and promotion keep the current codemap mode; in automatic mode, codemaps are still added for the files that the selected full files and slices reference. Clearing codemaps selects manual mode. See the [selection contracts](contracts.md#public-selection-and-explicit-registration) for transaction and registration ownership.

A supported file with no rendered codemap remains selected. Selection replies identify it in `code_structure.unmapped_paths`; it contributes no source or codemap body. Pending extraction left by cancellation can complete on a later explicit codemap request.

Set runtime or host `copyContext.codeMapsGloballyDisabled` to `true` to disable codemap generation and output, including cached signatures. `get_code_structure` returns an unavailable result with issue `codemaps_disabled`. Source reads and searches remain available. Packets and exports can include full files and slices. Codemap-only selection mutations are rejected; optional initial codemap membership remains recorded, and required codemaps return `codemapUnavailable`.

## Drafts

Create a draft from a workspace handle after declaring its roots and output directory. Creation reconciles the workspace and acquires required material before returning. `initialSelection` captures mutable starting sources and automatic/manual codemap mode; `requiredSources` declares evidence that must remain selected. Both modes accept full files, slices and codemaps. A draft owns its selections and pins exact source bytes; close each draft when finished. Closing the workspace handle does not revoke an existing draft.

```ts
const draft = await workspace.createDraft({
  task: 'Review the implementation and identify correctness risks.',
  initialSelection: { codemapMode: 'automatic', sources: [] },
  duplicateUserInstructionsAtTop: false,
  copyPreset: 'standard',
  constraints: 'Keep every required document complete.',
  enhancementMode: 'augment',
  purpose: 'review',
  requiredSources: [{ kind: 'full', source: { root: 'repo', path: 'src/index.ts' } }],
  documents: [{
    kind: 'suppliedDocument', id: 'prior-report', role: 'report',
    origin: 'Caller-provided prior review', text: completeReportText,
  }],
  patches: [],
  discoveryHints: [],
  outputName: 'review-001',
  budgetUnits: 100000,
}, signal);
try {
  await draft.prompt({
    expectedRevision: draft.revision,
    maxOutputBytes: 12000,
    op: 'append',
    text: '\n\n<discovered_architecture>Describe ownership and error handling here.</discovered_architecture>',
  }, signal);
  const validation = await draft.validate(signal);
  const result = await draft.finalize(signal);
  console.log(validation, result);
} finally {
  await draft.close();
}
```

`duplicateUserInstructionsAtTop` adds the complete resulting prompt before the context sections when true. The ordered user-instruction sections remain present; empty prompt text produces no user block. Set it to false for the source default. Every copy counts toward the assembly budget.

Set `promptSectionsOrder` to arrange `fileMap`, `fileContents`, `gitDiff`, `constraints` and `userInstructions`. Each name must occur at least once; repeated names emit complete repeated sections. Omit the field to use that default order. Item costs aggregate repeated material bodies and file blocks. Complete-packet measurement includes all copies and wrappers.

Set `includeDatetimeInUserInstructions` to true to add the native local datetime to each nonempty user-instruction block. The default is false. Repeated blocks share one timestamp, and its bytes count toward the budget. Saved packets retain that timestamp; current verification compares the remaining presentation independently of the clock.

## Copy presets

`copyPreset` selects `standard`, `manual`, `diffFollowUp` or `codeReview`, a UUID, or a preset name. An object with `id`, `kind` or `name` selects explicitly by those fields, in that priority. Kind lookup uses the original built-in; UUID and explicit-name lookup use the configured catalog with built-in overrides. Standard includes ordinary context; Review includes nonblank selected Git patches. Diff Follow-Up delivers Git evidence, caller constraints and literal user instructions. Use optional source selections to set its Git scope; required sources or documents produce `copyPresetRequiredMaterialConflict`.

Packets contain evidence, fixed constraints and the resulting task prompt. The calling agent system supplies the recipient's role separately, for example through a Pi subagent definition. Send the verified `context.md` as that recipient's input.

The required runtime or host `copyContext` configures current settings, Manual working-copy overrides, selected saved-prompt IDs, an active Git root and preset records. Each draft captures that context at admission. The [copy settings example](context-protocol.md#copy-settings-and-presets) lists every field. Manual supports no codemaps, automatic related maps, selected-file maps or complete maps across all declared roots. Selected-file mode can replace directly selected bodies with maps; slice-only entries retain their slices. Required bodies that a setting would exclude or replace return `copyPresetRequiredMaterialConflict`.

Use `prompt` with `input: { op: "list_presets" }` to list the raw configured catalog; no draft is needed. Use `input: { op: "export", path: "interim.md", copy_preset: "manual" }` and the owning `draftId` to write a complete UTF-8 context file under the declared output root. `copy_preset` is optional and applies only to that export. Existing files and symlink destinations are rejected. The draft remains inspectable, editable and finalizable. Cancellation before writing creates no destination; cancellation after a successful write can leave the complete file while returning cancellation.

Manual complete Git uses the explicit `activeGitRoot` and already-local comparison refs. A null root produces no complete diff. Missing local refs fail explicitly. Refresh remote-tracking refs yourself before requesting a comparison that needs them. Nonblank selected patch artifacts take precedence over both selected and complete Git acquisition.

Review and Diff Follow-Up export nonblank selected patch artifacts first. When none supplies text, they acquire a Git diff for the selected full files and slices. A slice includes its file's complete diff. The optional `reviewGitBase` sets the comparison: omission, blank text and case-insensitive `HEAD` compare the working tree against captured HEAD; another ref compares against its merge base with captured HEAD. Each checkout's comparison is frozen before diff acquisition. Configure `git.executable` for Git-backed selections. Partial repository or comparison failures appear as explicit diagnostics in the Git section. Caller-supplied `patches` remain complete and follow the selected or automatic Git text in every preset.

## Prompt and selection edits

A draft's prompt starts as `task`. A Context Builder build starts its draft with an empty prompt instead, like a new RPCE tab, and discovery receives `task`, followed by any `discoveryHints`, as its instructions. Set `defaultEnhancementMode` in the host configuration to `fullRewrite`, `augment` or `preserve`; omission selects Augment. A request's optional `enhancementMode` overrides that default. Discovery uses literal prompt operations: `set` replaces the current text, `append` adds text exactly, `clear` empties it and `get` returns it. Rewrite delivers the replacement; Augment keeps the starting prompt at the beginning and adds discoveries; Preserve leaves the starting prompt unchanged. These modes guide discovery rather than restricting the caller's explicit prompt operations. Caller constraints and required inputs remain fixed. Optional source updates use `upsert` with a `full`, `slices`, or `codemap` selection; `remove` removes an explicit optional selection. Slice ranges use one-based inclusive endpoints and descriptions. Upsert replaces the file's representation. Required representations cannot be removed or changed.

Drafts start in the starting selection's mode. Automatic mode adds related codemaps for full and sliced sources, except for files the selection already holds in any representation. `clearCodemaps` enters manual mode; `clearSources` restores the required sources in automatic mode. Clear operations retain documents, patches and the current prompt. [Selection contracts](contracts.md#drafts-and-material-ownership) describe promotion, inferred-source removal and comparison recovery.

Use `addDocument` with a `suppliedDocument` and a unique ID to retain complete text fetched during curation. Added documents are immutable and count toward the assembly budget.

`draft.inspect` provides `metadata`, `costs`, and `material` views with `maxOutputBytes` and `continuation`. Material inspection names a material ID from metadata, such as `document:prior-report`. It pages complete lines against a material digest. Updates return the committed revision, changed-item costs, total measurement, and unresolved diagnostics. If detail does not fit, the receipt identifies incomplete detail and the costs view supplies the complete breakdown.

## Budget

Set `contextBudgetUnits` in the host configuration to the default assembly budget. A request's optional `budgetUnits` overrides it, whether smaller or larger. For example, a 200000-unit default permits an explicitly requested 500000-unit build. Discovery receives `max(0, budgetUnits - 1500)`, following RPCE's reserve. Complete-packet measurement and publication enforce the resolved `budgetUnits`. The estimate is `floor(21 × UTF-8 bytes / 80)`, rather than an exact tokenizer count. Over-budget results report the excess and retain all material for explicit correction.

## Output and verification

Ready output contains `context.md`, `handoff.md`, and `manifest.json` beneath the declared output directory. Send only `context.md` to the recipient. Its sections contain the file map and codemaps, full and sliced file blocks, selected Git evidence, caller constraints and the current literal prompt. Supplied documents appear as full-file blocks labeled with their role, origin and ID. The coordinator records retain the original request, current prompt, byte spans, hashes, accounting and complete comparison receipts, including scope, resolved revisions, policies and target fingerprints. Output creation is exclusive. Readback and final source checks precede manifest publication.

Import `verifyBundle` to verify saved bytes without source access. `verifyCurrentBundle(directory, runtime, signal)` additionally reopens recorded roots and checks delivered local material, controlling ignore files, current configured denies, native codemap keys, and relevant comparisons. Unselected files are examined only when a requested live comparison needs them. Keep the saved packet unchanged after verification.

## Documents and patches

`localDocument` acquires a complete root-qualified document under workspace policy. `suppliedDocument` retains exact caller text and an asserted origin; that origin grants no filesystem access. All rendered text must be lossless UTF-8, with original BOMs and newline bytes retained. NUL-containing source is binary and cannot be selected as text or a codemap.

Supplied patches retain complete UTF-8 patch text, declared changed paths, source history, and target byte/mode evidence. Every selected source in an associated root must have matching target evidence. This verifies source coherence, not the external producer's underlying comparison.

Configure `git: { executable: '/absolute/path/to/git' }` on `MipmuxRuntime` for local patches. `PatchInput` supports explicit worktree, staged, and commit-endpoint comparisons, with an explicit commit or empty baseline and an all-paths or prefix-path scope. Worktree requests choose whether to include untracked files. The helper reads repository objects and generates patches from captured byte/mode pairs in private directories. Patches preserve deletion, addition, binary, empty-file, executable-mode, and quoted-name changes. Local symlink, gitlink, and unmerged entries produce errors. Staged and historical comparisons check selected supporting sources against the target as well as changed files.

Local patch inputs can use a declared root below its owning Git checkout. Comparison scope and receipt paths are relative to that declared root, while patch headers retain the checkout-relative prefix needed by `git apply`. Only files beneath the declared root participate in the comparison.
