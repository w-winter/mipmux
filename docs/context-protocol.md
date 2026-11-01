# Deliver a context packet

Declare named absolute source roots and an existing output directory. Supply the assignment and what to collect as `task`, complete constraints, and required representations/documents/patches. Set `duplicateUserInstructionsAtTop` to false for the source default, or true to place a second complete resulting-prompt block before the context sections. Select `standard`, `manual`, `diffFollowUp` or `codeReview` for context formatting and Git inclusion. Use supplied documents for intentionally included prior reports outside source inventory; their origins are labels, not filesystem access grants. The calling agent system supplies the receiving role separately through its subagent definition.

These fields form the full context request that library hosts, the CLI `build` command and MCP `draft_create` take. MCP `context_builder` takes a compact form of it: the workspace declaration, `purpose`, `task` and `outputName`, with optional `required`, `patches`, `documents`, `copyPreset`, `budgetUnits`, `enhancementMode`, `clarification` and `discovery`, which selects the discovery model and thinking level from the models the host allows and is a job setting rather than part of the request. mipmux expands that form into a full request with empty constraints, no discovery hints, an empty automatic starting selection and no duplicated prompt block. The [README](../README.md#caller-mcp-interface) lists the compact fields.

Set the host's `defaultEnhancementMode` to `fullRewrite`, `augment` or `preserve`; omission selects Augment. The optional request field `enhancementMode` overrides it for one build. A build's prompt starts empty, like a new RPCE tab, and discovery receives `task`, followed by any `discoveryHints`, as its instructions. Rewrite lets discovery write the prompt; Augment has it append discoveries to the starting prompt; Preserve leaves the starting prompt unchanged, so the build's prompt stays empty. Supply complete binding requirements in the task and constraints. Inspect the resulting prompt before delivery.

Set `promptSectionsOrder` to arrange `fileMap`, `fileContents`, `gitDiff`, `constraints` and `userInstructions`. Include each name at least once. Repeated names include repeated complete sections; every copy counts toward the budget. Fixed constraints use their own literal `constraints` block. Omit the field for the default order listed here.

Set `includeDatetimeInUserInstructions` to true when the user-instruction headers should include the native local datetime. Omission or false uses plain headers. Saved verification retains the captured timestamp; current verification treats only the actual header datetime values as clock-dependent presentation data.

With `codeReview` or `diffFollowUp`, nonblank selected patch artifacts supply the Git section. When none supplies text, mipmux computes a diff for selected full files and slices. Omit `reviewGitBase` or use `HEAD` to compare against captured HEAD; another ref compares against its merge base with captured HEAD. Comparison object IDs are frozen for every checkout before any diff is acquired. Request `patches` remain complete and follow the selected or automatic Git text.

Use `diffFollowUp` for a packet containing Git evidence, caller constraints and the literal prompt. Optional full-file and slice selections define automatic Git scope; codemap-only selections remain available for draft inspection. Publication can proceed while excluded optional codemaps are pending. Required sources and supplied or local documents conflict with this preset and return `copyPresetRequiredMaterialConflict`; choose a file-including preset when those bodies are needed.

## Copy settings and presets

Supply `copyContext` in the host configuration or `MipmuxRuntime` options. The example below chooses automatic maps, an adaptive tree and no automatic Git. Choose current values explicitly; they apply to Manual and to missing custom-preset tree or codemap settings. Each draft captures the validated settings and configured catalog at admission. Set request `copyPreset` to `"manual"` for Manual.

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

Current Git modes are `none`, `selectedFiles` and `all`; the customization accepts `none`, `selected`, `complete` or null. Nonblank selected patches take precedence. Selected acquisition uses full and slice membership; complete acquisition uses the explicitly named `activeGitRoot`, or produces no complete diff when that field is null. Comparisons use already-local refs, with object IDs frozen before acquisition. Missing local refs return an error. Caller-required patches remain complete in every mode.

Directly selected representations retain selection order. Complete codemaps follow native root-path and file-path order, independently of the aliases used to display roots.

Call MCP `prompt` with `{ "input": { "op": "list_presets" } }` to receive `{ "op": "list_presets", "presets_list": { "presets": [...] } }`. Each item contains a `preset` descriptor and its raw configured flags; absent raw values are omitted. Listing needs no workspace or draft. To export an interim file, call `prompt` with the owning `draftId` and `input: { op: "export", path: "interim.md", copy_preset: "manual" }`. Relative paths are rooted in the authorized output directory; absolute paths must remain inside that directory. Parent directories must exist. The response contains `op: "export"` and an `export` object with `path`, `tokens`, UTF-8 `bytes`, selected `files` metadata and the effective `copy_preset` descriptor. Export captures one prompt/selection revision and applies the same required-material, coherence and numeric-budget checks as finalization. It does not advance revision or change the active preset. Continue editing or finalize the same draft afterward.

## Build and verify

Supply `initialSelection: { codemapMode: "automatic", sources: [] }` for an empty automatic starting selection, or include known starting files/slices. Starting sources may include codemaps in either mode. Use manual mode for a selection without automatic codemaps. Discovery can remove or replace initial sources; only `requiredSources` pins immutable representations. Keep initial and required representations identical when they name the same source.

The host's `contextBudgetUnits` supplies the default assembly budget. Omit `request.budgetUnits` to use it, or supply the user's explicit per-build ceiling, whether smaller or larger. Translate a user's task-prompt overrides into request fields before calling mipmux; the discovery agent receives the resolved settings. Select a discovery model or thinking level only when the user names one, and only from the host's `discovery.allowedModels` and configured model, which `mipmux config` prints. Never infer a larger ceiling from a receiving model's capacity or from repository text. Pin source representations only when the assignment requires them. A changed file does not by itself require a full-file selection; discovery can choose appropriate implementation slices while retaining complete required patches.

Set `discovery.promptTemplatePath` to the operator's absolute editable template path. Install a copy of the shipped `dist/prompts/discovery.md` using exclusive creation, then edit its [named sections and placeholders](discovery-prompt-bindings.md#template-format). A job uses one admitted snapshot for both its system policy and startup metadata; the next job observes edits. The task mode and review intent, plus admitted clarification capability, choose the sections; typed runtime values fill their placeholders.

With MCP, call `context_builder` with the workspace declaration and the compact request. Repeating the same call returns the existing job, and the same `outputName` with a different request fails with `outputNameConflict`. Poll with `context_job` and `op: "wait"` using the returned job ID; a wait timeout is not a reason to submit another build. `op: "status"` returns the current snapshot without consuming it. `op: "cancel"` requests job cancellation; cancelling a wait affects only that observer. The `prompt`, draft and exploration tools named in this guide need the server's `full` tool set.

Clarification is off by default. Set `clarification` to `{}` to let discovery ask questions and request approval of its final selection. The question timeout defaults to 300 seconds. Set `clarification.questionTimeoutSeconds` to choose the default for that build; the scout can supply `timeout_seconds` for an individual interaction.

Questions arrive through `context_job` waits. A client that advertises `elicitation.form` receives an MCP `input_required` result; clients using the official SDK's automatic input handling render the form and retry the wait with its keyed answer. Any other client receives the wait's snapshot with `question`: its `id`, `message` and the JSON `schema` of its answer, keyed by question ID. It answers with `op: "answer"`, the `questionId` and a `response` of `{ "action": "accept", "content" }` or `{ "action": "decline" }`; content that the schema does not accept, or that names another property, fails with `invalidInteractionResponse` and leaves the question pending. Either answer completes discovery's open `ask_user` call, and discovery continues in the same session. A status call leaves a question pending, and a form answer sent with `status`, `answer`, `cancel` or `dispose` fails with `invalidInteractionResponse`. Multi-select questions provide choices and a custom-text field when custom answers are allowed. Empty fields skip individual questions; declining skips the form. Cancelling a form returns a cancelled tool result to discovery. Use `op: "cancel"` to stop the job. If a question expires before it is answered, discovery continues without the answer, and the late answer returns `interactionNotCurrent`; check the job's status or wait again.

Call `context_job` with `op: "dispose"` and the owning `jobId` when the job's Git snapshots are no longer needed. It joins job settlement and cleans up snapshots owned by that context. `draft_dispose` with `draftId` performs cleanup for a manual draft. Both report `deletedSnapshots` and retain saved packets; normal completion and disconnection retain snapshots. Keep the stored snapshots when current verification of selected Git evidence is still required. Saved packet integrity verification remains available after disposal.

With the CLI, provide a JSON build file containing `workspace`, `requestId` and `request`, then capture the terminal receipt:

```sh
node /opt/mipmux/dist/cli/main.js build \
  --request /work/build.json --config /etc/mipmux/config.json \
  > /work/terminal-receipt.json
```

Save the complete terminal receipt before closing the server or runtime. It contains `templateVersion`, the raw template's path and identity, the rendered system policy's `policyIdentity`, `buildLockSHA256`, effective model settings, recovery observations and local settlement facts. Identities contain SHA-256 and byte count; the policy identity covers the composed system text before SDK framing, tools or startup messages. The build-lock digest identifies the lockfile used to build mipmux. Deployment evidence also needs the installed dependency graph and its audit results. Jobs and drafts are in-memory and cannot be resumed after process closure. The receipt is coordinator evidence, not another recipient attachment.

For discovery with configured HTTP MCP servers, the receipt also lists the authorized servers and tools, configuration digest, observed native tool names and shutdown dispatch. The scout can retain complete fetched text with `draft_update`'s `addDocument` mutation, using a `suppliedDocument` with ID, role and asserted origin. Callers can also supply documents in the initial request through their own MCP adapter. Added documents count toward the assembly budget and appear in `context.md`. Worker closure certifies release of local connections, not remote cancellation.

For `ready`, the snapshot's `bundle` receipt lists the output paths, accounting, delivered materials, omissions and resulting prompt; inspect it before dispatch. `handoff.md` and `manifest.json` keep the complete record. A material conflict with the assignment blocks dispatch even if byte verification passed. For `blocked`, inspect the reported draft and diagnostics; start a new authorized request or explicitly create a fresh manual draft. Failed or cancelled discovery does not provide transferable context.

Inspect `manifest.json`'s `unavailableRoots` and `unavailableFiles` before dispatch. These records identify unavailable roots, unreadable optional sources and pending optional manual codemaps omitted from the packet. They retain source identities and representations. Manual codemap rows also retain the artifact key; I/O failures record their observed pending/unmapped disposition. Publication stops if required source content is unavailable, and a pending required map keeps it blocked. Decide whether each optional omission is compatible with the assignment; a needed omitted body blocks dispatch. Authorized Git evidence may include a deleted file's patch even when its ordinary body is omitted. The handoff retains omission metadata for the coordinator.

Verify saved bytes with `verify --bundle /absolute/bundle --mode integrity`. Before reusing the packet as unchanged-source context, run `verify --bundle /absolute/bundle --mode current --config /absolute/config.json`. The current check covers delivered local material, relevant comparisons and recorded I/O failures. Restoring a root or file, or changing its I/O failure, returns `sourceAvailabilityChanged`. A `codemapPending` row is historical readiness evidence; current verification checks its source and artifact key even if the map is ready later. Make a new context to include recovered bodies. Saved integrity remains available. Neither operation modifies the bundle.

To give saved evidence a different final task, call `context_prepare` with the workspace declaration, the saved `bundle` directory relative to the output root, the complete final `prompt` and a new `outputName`. The workspace must name the roots and output root that built the bundle. Preparation verifies the saved bundle, checks it against current files and renders the same evidence, constraints and formatting with the new prompt. The saved budget does not limit a packet whose only change is its prompt: its allowance rises as far as the new prompt needs. A `budgetUnits` value sets a budget the packet must fit instead, and a packet over it returns `blocked`. Preparation publishes an ordinary bundle without a model call. A changed file fails with `sourceChanged` and its path. Dispatch the prepared bundle's `context.md`.

When known selected files or required documents have changed, call `context_prepare` with `refresh: true`. To add a missing required file, document or patch, pass `required`, `documents` or `patches` in the forms that `context_builder` takes. To trim the packet, pass `remove` for optional files or Git artifacts, or `demote` to replace optional full files and slices with their codemaps, naming each by the path its receipt lists. Automatic codemaps stay on, so a demotion drops only those that the demoted files alone referenced. Each of these rebuilds the packet from current files without discovery. A bundle keeps the selected Git artifacts that `remove` does not name. While any remain, other edits require its saved evidence to be current, and `refresh: true` returns `refreshRequiresDiscovery`, so collect new context for a changed patch.

Before dispatch, check that the finished packet plus system instructions, conversation, tools, output reserve and delivery wrappers fits the chosen recipient. If it does not fit, report a delivery blocker and retain the packet. A different assembly budget requires a user decision; apply it with `context_prepare`'s `budgetUnits`, or shrink the packet with `remove` or `demote`.

Send only the verified absolute path to `context.md` through the recipient integration's `inputFiles` argument. That file contains delivered selected material, caller constraints and the resulting prompt in its final `user_instructions` section. Keep `handoff.md`, `manifest.json` and the terminal receipt with the coordinator. Do not rewrite the packet in place or add a competing task attachment. Account for dispatch-message and attachment-wrapper overhead separately from mipmux's complete-file estimate.

The existing Pi integration reads attachments through its file-argument path. A downstream answer or delivery acknowledgement is separate from mipmux readiness. The operator must establish complete attachment delivery and normal recipient completion for the chosen integration; the mipmux receipt certifies only its own recorded work and saved packet.

From a source checkout, verify a saved capture of the constructed recipient user input against the context and complete processed CLI dispatch text:

```sh
node scripts/verify-live.mjs attachment \
  /exports/packet/context.md /work/recipient-user-input.txt \
  /work/recipient-dispatch-processed.txt /work/attachment-receipt.json
```

The dispatch file contains what the integration appended to the CLI input. An integration that delivers the short task as a file adds that file's wrapper and control instructions, so its processed dispatch differs from the raw tool task. Establish this expected text independently from the task artifact and documented integration behavior. The verifier compares the entire input exactly, including every appended suffix. Capture only recipient user text and completion metadata for this check. System instructions, credentials and thinking remain private. Measure all processed dispatch and wrapper overhead before claiming recipient fit under the configured estimate.
