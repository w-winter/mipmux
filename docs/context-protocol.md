# Deliver a context packet

Declare named absolute source roots and an existing output directory. Supply the complete assignment as `task`, complete constraints, required representations/documents/patches, and numeric `budgetUnits`. Set `duplicateUserInstructionsAtTop` to false for the source default, or true to place a second complete resulting-prompt block before the context sections. Set `copyPreset` to `standard`, `plan`, `diffFollowUp` or `codeReview` for the corresponding source copy preset. Supply a `storedPrompts` catalog of `{ id, title, content }` entries; an empty array supplies no saved roles. Plan selects its source architect UUID `8e81aac2-79ce-4897-a59e-efd81eebb7e9`; Review selects its source UUID `d7f1b2e4-3c5a-6b8d-cf8e-1f5d0e2a4c6b`. Use supplied documents for intentionally included prior reports outside source inventory; their origins are labels, not filesystem access grants.

Set `enhancementMode` to `fullRewrite`, `augment` or `preserve`. Rewrite lets discovery replace the prompt; Augment retains the original and appends discoveries; Preserve keeps the original text unchanged. Supply complete binding requirements in the task and constraints. Inspect the resulting prompt before delivery.

Set `promptSectionsOrder` to arrange `fileMap`, `fileContents`, `gitDiff`, `metaPrompts` and `userInstructions`. Include each name at least once. Repeated names include repeated complete sections; every copy counts toward the budget. Omit the field for the default order listed here.

Set `includeDatetimeInUserInstructions` to true when the user-instruction headers should include the native local datetime. Omission or false uses plain headers. Saved verification retains the captured timestamp; current verification treats only the actual header datetime values as clock-dependent presentation data.

With `codeReview` or `diffFollowUp`, nonblank selected patch artifacts supply the Git section. When none supplies text, smip computes a diff for selected full files and slices. Omit `reviewGitBase` or use `HEAD` to compare against captured HEAD; another ref compares against its merge base with captured HEAD. Comparison object IDs are frozen for every checkout before any diff is acquired. Request `patches` remain complete and follow the selected or automatic Git text.

Use `diffFollowUp` for a packet containing Git evidence, caller constraints and the literal prompt. Optional full-file and slice selections define automatic Git scope; codemap-only selections remain available for draft inspection. Publication can proceed while excluded optional codemaps are pending. Required sources and supplied or local documents conflict with this preset and return `copyPresetRequiredMaterialConflict`; choose a file-including preset when those bodies are needed.

Supply `initialSelection: { codemapMode: "automatic", sources: [] }` for an empty automatic starting selection, or include known starting files/slices. Use manual mode for an explicit codemap selection or a manual selection with no codemaps. Discovery can remove or replace initial sources; only `requiredSources` pins immutable representations. Keep initial and required representations identical when they name the same source.

Read the operator's `contextBudgetUnits` from the host configuration and set `request.budgetUnits` to that value. A smaller budget requires the user's instruction. Context assembly needs the task, sources and budget; choosing a receiving model belongs to delivery. Pin source representations only when the assignment requires them. A changed file does not by itself require a full-file selection; discovery can choose appropriate implementation slices while retaining complete required patches.

With MCP, call `workspace_declare` and save the returned ID. Call `context_builder` with that `workspaceId`, a caller-generated `requestId`, and the context request. Poll with `context_builder_wait` using the same job ID; a wait timeout is not a reason to submit another builder request. `context_builder_result` returns the current snapshot without consuming it. `context_builder_cancel` requests job cancellation; cancelling a wait affects only that observer.

Clarification is off by default. Set `request.clarification` to `{}` to let discovery ask questions and request approval of its final selection. The connected MCP client must advertise `elicitation.form` and handle form elicitation; otherwise admission returns `elicitationUnavailable`. The question timeout defaults to 300 seconds. Set `clarification.questionTimeoutSeconds` to choose the default for that build; the scout can supply `timeout_seconds` for an individual interaction.

Questions arrive through `context_builder_wait` as MCP `input_required` results. Clients using the official SDK's automatic input handling render the form and retry the wait with its keyed answer. Multi-select questions provide choices and a custom-text field when custom answers are allowed. Empty fields skip individual questions; declining skips the form. Cancelling a form returns a cancelled tool result to discovery. Use `context_builder_cancel` to stop the job. If a question expires before its form is answered, the late answer returns `interactionNotCurrent`; fetch the current job result or wait again.

Call `context_builder_dispose` with the owning `jobId` when the job's Git snapshots are no longer needed. It joins job settlement and cleans up snapshots owned by that context. `draft_dispose` with `draftId` performs cleanup for a manual draft. Both report `deletedSnapshots` and retain saved packets; normal completion and disconnection retain snapshots. Keep the stored snapshots when current verification of selected Git evidence is still required. Saved packet integrity verification remains available after disposal.

With the CLI, provide a JSON build file containing `workspace`, `requestId` and `request`, then capture the terminal receipt:

```sh
node /opt/smip/dist/cli/main.js build \
  --request /work/build.json --config /etc/smip/config.json \
  > /work/terminal-receipt.json
```

Save the complete terminal receipt before closing the server or runtime. It contains the prompt identity, `buildLockSHA256`, effective model settings, recovery observations and local settlement facts. The build-lock digest identifies the lockfile used to build smip. Deployment evidence also needs the installed dependency graph and its audit results. Jobs and drafts are in-memory and cannot be resumed after process closure. The receipt is coordinator evidence, not another recipient attachment.

For discovery with configured HTTP MCP servers, the receipt also lists the authorized servers and tools, configuration digest, observed native tool names and shutdown dispatch. The scout can retain complete fetched text with `draft_update`'s `addDocument` mutation, using a `suppliedDocument` with ID, role and asserted origin. Callers can also supply documents in the initial request through their own MCP adapter. Added documents count toward the assembly budget and appear in `context.md`. Worker closure certifies release of local connections, not remote cancellation.

For `ready`, inspect `handoff.md` and the receipt for the original request, resulting prompt, coverage limitations and the actual output paths. A material conflict with the assignment blocks dispatch even if byte verification passed. For `blocked`, inspect the reported draft and diagnostics; start a new authorized request or explicitly create a fresh manual draft. Failed or cancelled discovery does not provide transferable context.

Inspect `manifest.json`'s `unavailableRoots` and `unavailableFiles` before dispatch. These records identify unavailable roots, unreadable optional sources and pending optional manual codemaps omitted from the packet. They retain source identities and representations. Manual codemap rows also retain the artifact key; I/O failures record their observed pending/unmapped disposition. Publication stops if required source content is unavailable, and a pending required map keeps it blocked. Decide whether each optional omission is compatible with the assignment; a needed omitted body blocks dispatch. Authorized Git evidence may include a deleted file's patch even when its ordinary body is omitted. The handoff retains omission metadata for the coordinator.

Verify saved bytes with `verify --bundle /absolute/bundle --mode integrity`. Before reusing the packet as unchanged-source context, run `verify --bundle /absolute/bundle --mode current --config /absolute/config.json`. The current check covers delivered local material, relevant comparisons and recorded I/O failures. Restoring a root or file, or changing its I/O failure, returns `sourceAvailabilityChanged`. A `codemapPending` row is historical readiness evidence; current verification checks its source and artifact key even if the map is ready later. Make a new context to include recovered bodies. Saved integrity remains available. Neither operation modifies the bundle.

Before dispatch, check that the finished packet plus system instructions, conversation, tools, output reserve and delivery wrappers fits the chosen recipient. If it does not fit, report a delivery blocker and retain the packet. A different assembly budget requires a user decision and a new build.

Send only the verified absolute path to `context.md` through the recipient integration's `inputFiles` argument. That file contains delivered selected material, caller constraints and the resulting prompt in its final `user_instructions` section. Keep `handoff.md`, `manifest.json` and the terminal receipt with the coordinator. Do not rewrite the packet in place or add a competing task attachment. Account for dispatch-message and attachment-wrapper overhead separately from smip's complete-file estimate.

The existing Pi integration reads attachments through its file-argument path. A downstream answer or delivery acknowledgement is separate from smip readiness. The operator must establish complete attachment delivery and normal recipient completion for the chosen integration; the smip receipt certifies only its own recorded work and saved packet.

From a source checkout, verify a saved capture of the constructed recipient user input against the context and complete processed CLI dispatch text:

```sh
node scripts/verify-live.mjs attachment \
  /exports/packet/context.md /work/recipient-user-input.txt \
  /work/recipient-dispatch-processed.txt /work/attachment-receipt.json
```

The dispatch file contains what the integration appended to the CLI input. An integration that delivers the short task as a file adds that file's wrapper and control instructions, so its processed dispatch differs from the raw tool task. Establish this expected text independently from the task artifact and documented integration behavior. The verifier compares the entire input exactly, including every appended suffix. Capture only recipient user text and completion metadata for this check. System instructions, credentials and thinking remain private. Measure all processed dispatch and wrapper overhead before claiming recipient fit under the configured estimate.
