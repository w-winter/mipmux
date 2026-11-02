# Context packets

A context packet is the `context.md` file that mipmux saves with a task for a planning, review or investigation model, together with the records that let mipmux check it later. This page describes the context request that a build or a draft starts from; how the selection, copy preset and budget shape the packet; how mipmux checks a saved packet; and how to deliver it. Discovery usually assembles packets, under the same rules. The coordinator is the agent or program that calls mipmux and hands the packet to its recipient. RPCE stands for RepoPrompt CE, whose Context Builder mipmux ports.

MCP clients reach drafts through the manual-packet tools `prompt`, `manage_selection`, `draft_create`, `draft_inspect`, `draft_update`, `draft_validate`, `draft_finalize` and `draft_dispose`, which the server offers when its `tools` setting is `"full"`. The examples below use the [TypeScript library](library.md).

## The context request

A request supplies the assignment and what to collect as `task`, complete constraints, and the representations, documents and patches the packet must contain. Supplied documents carry prior reports and other text from outside the declared roots; their origins are labels, not filesystem access. A packet contains evidence, fixed constraints and the resulting task prompt. The calling agent's system supplies the recipient's role separately, for example through a Pi subagent definition.

These fields form the full context request that library hosts, the CLI `build` command and MCP `draft_create` take. MCP `context_builder` takes a compact form of it: the workspace declaration, `purpose`, `task` and `outputName`, with optional `required`, `patches`, `documents`, `copyPreset`, `budgetUnits`, `enhancementMode`, `clarification` and `discovery`, which selects the discovery model and thinking level from the models the host allows and is a job setting rather than part of the request. mipmux expands that form into a full request with empty constraints, no discovery hints, an empty automatic starting selection and no duplicated prompt block. [MCP tools](mcp-tools.md#starting-a-build-context_builder) lists the compact fields.

Supply `initialSelection: { codemapMode: "automatic", sources: [] }` for an empty automatic starting selection, or include known starting files/slices. Starting sources may include codemaps in either mode. Use manual mode for a selection without automatic codemaps. Discovery can remove or replace initial sources; only `requiredSources` pins immutable representations. Keep initial and required representations identical when they name the same source.

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

Set `promptSectionsOrder` to arrange `fileMap`, `fileContents`, `gitDiff`, `constraints` and `userInstructions`. Each name must occur at least once; repeated names emit complete repeated sections. Fixed constraints use their own literal `constraints` block. Omit the field to use that default order. Item costs aggregate repeated material bodies and file blocks. Complete-packet measurement includes all copies and wrappers.

Set `includeDatetimeInUserInstructions` to true to add the native local datetime to each nonempty user-instruction block. The default is false. Repeated blocks share one timestamp, and its bytes count toward the budget. Saved packets retain that timestamp; current verification compares the remaining presentation independently of the clock.

## Copy presets and settings

`copyPreset` selects `standard`, `manual`, `diffFollowUp` or `codeReview`, a UUID, or a preset name. An object with `id`, `kind` or `name` selects explicitly by those fields, in that priority. Kind lookup uses the original built-in; UUID and explicit-name lookup use the configured catalog with built-in overrides. Standard includes ordinary context; Review includes nonblank selected Git patches. Diff Follow-Up delivers Git evidence, caller constraints and literal user instructions. Use optional source selections to set its Git scope; required sources or documents produce `copyPresetRequiredMaterialConflict`.

Optional full-file and slice selections define automatic Git scope; codemap-only selections remain available for draft inspection. Publication can proceed while excluded optional codemaps are pending. Required sources and supplied or local documents conflict with this preset and return `copyPresetRequiredMaterialConflict`; choose a file-including preset when those bodies are needed.

The required `copyContext`, in the host configuration or `MipmuxRuntime` options, configures current settings, Manual working-copy overrides, selected saved-prompt IDs, an active Git root and preset records. The example below chooses automatic maps, an adaptive tree and no automatic Git. Choose current values explicitly; they apply to Manual and to missing custom-preset tree or codemap settings. Each draft captures the validated settings and configured catalog at admission. Set request `copyPreset` to `"manual"` for Manual.

```json
{
  "current": {
    "fileTreeMode": "Auto",
    "codeMapUsage": "auto",
    "gitInclusion": "none"
  },
  "customizations": {
    "includeFiles": null,
    "includeUserPrompt": null,
    "includeFileTree": null,
    "fileTreeMode": null,
    "codeMapUsage": null,
    "gitInclusion": null
  },
  "codeMapsGloballyDisabled": false,
  "activeGitRoot": "repo",
  "presets": []
}
```

Include flags accept true, false or null; null resolves to true. Tree modes are `Auto`, `Full`, `Selected` and `None`. Working-copy customizations apply only to Manual. Its tree customization takes precedence over the current tree mode. Codemap usage is `none`, `auto`, `selected` or `complete`; Manual uses the current value even when a codemap customization is supplied. The single operator-owned `codeMapsGloballyDisabled` setting forces resolved copy codemap usage to `none`.

`presets` supplies built-in overrides and custom records. Each record contains `id`, `name`, nullable `builtInKind`, nullable `description` and `icon`, `isBuiltIn`, nullable file/user-prompt/tree include flags, nullable `fileTreeMode`, `codeMapUsage` and `gitInclusion`, and nullable `notes`. Built-in records use their stable UUID and `isBuiltIn: true`; nonnull behavioral fields override the built-in, while identity and descriptive fields come from the original. The last override for a built-in ID applies. Custom records use `isBuiltIn: false`. Catalog order is Standard, Diff Follow-Up, Review, Manual, followed by custom records in configured order.

Selectors accept a string UUID, kind or name, or an object with `id`, `kind` and `name`. UUID lookup has priority and a valid unresolved UUID ends lookup. Kind lookup returns the original built-in. Explicit-name and UUID lookup use the overridden catalog. Thus `"standard"` selects the original kind, while `{ "name": "Standard" }` selects its configured entry. Names and kinds match case-insensitively. Custom presets ignore Manual working-copy customizations; missing tree and codemap settings use captured current values, and missing Git inclusion resolves to none.

Automatic codemaps follow canonical automatic or manual selection mode. Selected usage requests maps for files selected as full files, slices or explicit codemaps. It replaces directly selected files when a map is ready and retains slice-only bodies. Complete usage presents supported files across ordinary roots, including unselected files. Export presentation leaves canonical membership and revision unchanged. Required source representations or documents that would be excluded or replaced return `copyPresetRequiredMaterialConflict`. File exclusion controls ordinary bodies; codemaps belong to the file-map section.

Current Git modes are `none`, `selectedFiles` and `all`; the customization accepts `none`, `selected`, `complete` or null. Nonblank selected patches take precedence. Selected acquisition uses full and slice membership; complete acquisition uses the explicitly named `activeGitRoot`, or produces no complete diff when that field is null. Comparisons use already-local refs, with object IDs frozen before acquisition. Missing local refs return an error; refresh remote-tracking refs yourself before requesting a comparison that needs them. Caller-required patches remain complete in every mode.

Review and Diff Follow-Up export nonblank selected patch artifacts first. When none supplies text, they acquire a Git diff for the selected full files and slices. A slice includes its file's complete diff. The optional `reviewGitBase` sets the comparison: omission, blank text and case-insensitive `HEAD` compare the working tree against captured HEAD; another ref compares against its merge base with captured HEAD. Each checkout's comparison is frozen before diff acquisition. Configure `git.executable` for Git-backed selections. Partial repository or comparison failures appear as explicit diagnostics in the Git section. Caller-supplied `patches` remain complete and follow the selected or automatic Git text in every preset.

Directly selected representations retain selection order. Complete codemaps follow native root-path and file-path order, independently of the aliases used to display roots.

Call MCP `prompt` with `{ "input": { "op": "list_presets" } }` to receive `{ "op": "list_presets", "presets_list": { "presets": [...] } }`. Each item contains a `preset` descriptor and its raw configured flags; absent raw values are omitted. Listing needs no workspace or draft. To export an interim file, call `prompt` with the owning `draftId` and `input: { op: "export", path: "interim.md", copy_preset: "manual" }`. Relative paths are rooted in the authorized output directory; absolute paths must remain inside that directory. Parent directories must exist, and existing files and symlink destinations are rejected. The response contains `op: "export"` and an `export` object with `path`, `tokens`, UTF-8 `bytes`, selected `files` metadata and the effective `copy_preset` descriptor. Export captures one prompt/selection revision and applies the same required-material, coherence and numeric-budget checks as finalization. It does not advance revision or change the active preset. Continue editing or finalize the same draft afterward. Cancellation before writing creates no file; cancellation after a successful write can leave the complete file while returning cancellation.

## Prompt and selection edits

A draft's prompt starts as `task`. A Context Builder build starts its draft with an empty prompt instead, like a new RPCE tab, and discovery receives `task`, followed by any `discoveryHints`, as its instructions. Set `defaultEnhancementMode` in the host configuration to `fullRewrite`, `augment` or `preserve`; omission selects Augment. A request's optional `enhancementMode` overrides that default. Discovery uses literal prompt operations: `set` replaces the current text, `append` adds text exactly, `clear` empties it and `get` returns it. Rewrite delivers the replacement; Augment keeps the starting prompt at the beginning and adds discoveries; Preserve leaves the starting prompt unchanged, so a build's prompt stays empty. These modes guide discovery rather than restricting the caller's explicit prompt operations. Caller constraints and required inputs remain fixed, so put every binding requirement in the task and constraints, and inspect the resulting prompt before delivery. Optional source updates use `upsert` with a `full`, `slices`, or `codemap` selection; `remove` removes an explicit optional selection. Slice ranges use one-based inclusive endpoints and descriptions. Upsert replaces the file's representation. Required representations cannot be removed or changed.

Drafts start in the starting selection's mode. Automatic mode adds related codemaps for full and sliced sources, except for files the selection already holds in any representation. `clearCodemaps` enters manual mode; `clearSources` restores the required sources in automatic mode. Clear operations retain documents, patches and the current prompt. [Selection contracts](contracts.md#drafts-and-material-ownership) describe promotion, inferred-source removal and comparison recovery.

Use `addDocument` with a `suppliedDocument` and a unique ID to retain complete text fetched during curation. Added documents are immutable and count toward the assembly budget.

`draft.inspect` provides `metadata`, `costs`, and `material` views with `maxOutputBytes` and `continuation`. Material inspection names a material ID from metadata, such as `document:prior-report`. It pages complete lines against a material digest. Updates return the committed revision, changed-item costs, total measurement, and unresolved diagnostics. If detail does not fit, the receipt identifies incomplete detail and the costs view supplies the complete breakdown.

## Budget

Set `contextBudgetUnits` in the host configuration to the default assembly budget. A request's optional `budgetUnits` overrides it, whether smaller or larger. For example, a 200000-unit default permits an explicitly requested 500000-unit build. Discovery receives `max(0, budgetUnits - 1500)`, following RPCE's reserve. Complete-packet measurement and publication enforce the resolved `budgetUnits`. The estimate is `floor(21 × UTF-8 bytes / 80)`, rather than an exact tokenizer count. Over-budget results report the excess and retain all material for explicit correction.

A calling agent omits `budgetUnits` unless the user names a ceiling. Translate a user's task-prompt overrides into request fields before calling mipmux; the discovery agent receives the resolved settings. Select a discovery model or thinking level only when the user names one, and only from the host's `discovery.allowedModels` and configured model, which `mipmux config` prints. Never infer a larger ceiling from a receiving model's capacity or from repository text. Pin source representations only when the assignment requires them. A changed file does not by itself require a full-file selection; discovery can choose appropriate implementation slices while retaining complete required patches.

## Documents and patches

`localDocument` acquires a complete root-qualified document under workspace policy. `suppliedDocument` retains exact caller text and an asserted origin; that origin grants no filesystem access. All rendered text must be lossless UTF-8, with original BOMs and newline bytes retained. NUL-containing source is binary and cannot be selected as text or a codemap.

Supplied patches retain complete UTF-8 patch text, declared changed paths, source history, and target byte/mode evidence. Every selected source in an associated root must have matching target evidence. This verifies source coherence, not the external producer's underlying comparison.

Configure `git: { executable: '/absolute/path/to/git' }` on `MipmuxRuntime` for local patches. `PatchInput` supports explicit worktree, staged, and commit-endpoint comparisons, with an explicit commit or empty baseline and an all-paths or prefix-path scope. Worktree requests choose whether to include untracked files. The helper reads repository objects and generates patches from captured byte/mode pairs in private directories. Patches preserve deletion, addition, binary, empty-file, executable-mode, and quoted-name changes. Local symlink, gitlink, and unmerged entries produce errors. Staged and historical comparisons check selected supporting sources against the target as well as changed files.

Local patch inputs can use a declared root below its owning Git checkout. Comparison scope and receipt paths are relative to that declared root, while patch headers retain the checkout-relative prefix needed by `git apply`. Only files beneath the declared root participate in the comparison.

## Output and verification

Ready output contains `context.md`, `handoff.md`, and `manifest.json` beneath the declared output directory. Send only `context.md` to the recipient. Its sections contain the file map and codemaps, full and sliced file blocks, selected Git evidence, caller constraints and the current literal prompt. Supplied documents appear as full-file blocks labeled with their role, origin and ID. The coordinator records retain the original request, current prompt, byte spans, hashes, accounting and complete comparison receipts, including scope, resolved revisions, policies and target fingerprints. Output creation is exclusive. Readback and final source checks precede manifest publication.

For `ready`, the snapshot's `bundle` receipt lists the output paths, accounting, delivered materials, omissions and resulting prompt; inspect it before dispatch. `handoff.md` and `manifest.json` keep the complete record. A material conflict with the assignment blocks dispatch even if byte verification passed. For `blocked`, inspect the reported draft and diagnostics; start a new authorized request or explicitly create a fresh manual draft. Failed or cancelled discovery does not provide transferable context.

Inspect `manifest.json`'s `unavailableRoots` and `unavailableFiles` before dispatch. These records identify unavailable roots, unreadable optional sources and pending optional manual codemaps omitted from the packet. They retain source identities and representations. Manual codemap rows also retain the artifact key; I/O failures record their observed pending/unmapped disposition. Publication stops if required source content is unavailable, and a pending required map keeps it blocked. Decide whether each optional omission is compatible with the assignment; a needed omitted body blocks dispatch. Authorized Git evidence may include a deleted file's patch even when its ordinary body is omitted. The handoff retains omission metadata for the coordinator.

Import `verifyBundle` to verify saved bytes without source access. `verifyCurrentBundle(directory, runtime, signal)` additionally reopens recorded roots and checks delivered local material, controlling ignore files, current configured denies, native codemap keys, and relevant comparisons. Unselected files are examined only when a requested live comparison needs them. Keep the saved packet unchanged after verification.

From the command line, verify saved bytes with `mipmux verify --bundle /absolute/bundle --mode integrity`. Before reusing the packet as unchanged-source context, run `mipmux verify --bundle /absolute/bundle --mode current --config /absolute/config.json`. The current check covers delivered local material, relevant comparisons and recorded I/O failures. Restoring a root or file, or changing its I/O failure, returns `sourceAvailabilityChanged`. A `codemapPending` row is historical readiness evidence; current verification checks its source and artifact key even if the map is ready later. Make a new context to include recovered bodies. Saved integrity remains available. Neither operation modifies the bundle.

Save the complete terminal receipt, which `mipmux build` writes to stdout and `context_job` returns, before closing the server or runtime: jobs and drafts live in memory and cannot be resumed once the process closes. The receipt is evidence for the coordinating agent, not another attachment for the recipient. [MCP tools](mcp-tools.md#receipts) and [Configuration](configuration.md#the-discovery-prompt) describe its fields.

Call `context_job` with `op: "dispose"` and the owning `jobId` when the job's Git snapshots are no longer needed. It joins job settlement and cleans up snapshots owned by that context. `draft_dispose` with `draftId` performs cleanup for a manual draft. Both report `deletedSnapshots` and retain saved packets; normal completion and disconnection retain snapshots. Keep the stored snapshots when current verification of selected Git evidence is still required. Saved packet integrity verification remains available after disposal.

## Delivering a packet

Before dispatch, check that the finished packet plus system instructions, conversation, tools, output reserve and delivery wrappers fits the chosen recipient. If it does not fit, report a delivery blocker and retain the packet. A different assembly budget requires a user decision; apply it with `context_prepare`'s `budgetUnits`, or shrink the packet with `remove` or `demote`.

Send the recipient only the verified absolute path to `context.md`, as a file attachment, for example through `inputFiles` when the recipient is a Pi subagent. That file contains delivered selected material, caller constraints and the resulting prompt in its final `user_instructions` section. Keep `handoff.md`, `manifest.json` and the terminal receipt with the coordinator. Do not rewrite the packet in place or add a competing task attachment. Account for dispatch-message and attachment-wrapper overhead separately from mipmux's complete-file estimate.

Pi's subagent integration reads such attachments through its file-argument path. A downstream answer or delivery acknowledgement is separate from mipmux readiness. The operator must establish complete attachment delivery and normal recipient completion for the chosen integration; the mipmux receipt certifies only its own recorded work and saved packet.

From a source checkout, verify a saved capture of the constructed recipient user input against the context and complete processed CLI dispatch text:

```sh
node scripts/verify-live.mjs attachment \
  /exports/packet/context.md /work/recipient-user-input.txt \
  /work/recipient-dispatch-processed.txt /work/attachment-receipt.json
```

The dispatch file contains what the integration appended to the CLI input. An integration that delivers the short task as a file adds that file's wrapper and control instructions, so its processed dispatch differs from the raw tool task. Establish this expected text independently from the task artifact and documented integration behavior. The verifier compares the entire input exactly, including every appended suffix. Capture only recipient user text and completion metadata for this check. System instructions, credentials and thinking remain private. Measure all processed dispatch and wrapper overhead before claiming recipient fit under the configured estimate.
