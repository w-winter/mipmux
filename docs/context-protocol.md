# Deliver a context packet

Declare named absolute source roots and an existing output directory. Supply the complete recipient assignment as `task`, complete constraints, required representations/documents/patches, and an allowance that reserves recipient conversation and delivery overhead. Use supplied documents for intentionally included prior reports outside source inventory; their origins are labels, not filesystem access grants.

With MCP, call `workspace_declare` and save the returned ID. Call `context_builder` with that `workspaceId`, a caller-generated `requestId`, and the context request. Poll with `context_builder_wait` using the same job ID; a wait timeout is not a reason to submit another builder request. `context_builder_result` returns the current snapshot without consuming it. `context_builder_cancel` requests job cancellation; cancelling a wait affects only that observer.

With the CLI, provide a JSON build file containing `workspace`, `requestId` and `request`, then capture the terminal receipt:

```sh
node /opt/smip/dist/cli/main.js build \
  --request /work/build.json --config /etc/smip/config.json \
  > /work/terminal-receipt.json
```

Save the complete terminal receipt before closing the server or runtime. It contains the prompt identity, `buildLockSHA256`, effective model settings, recovery observations and local settlement facts. The build-lock digest identifies the lockfile used to build smip. Deployment evidence also needs the installed dependency graph and its audit results. Jobs and drafts are in-memory and cannot be resumed after process closure. The receipt is coordinator evidence, not another recipient attachment.

For discovery with configured HTTP MCP servers, the receipt also lists the authorized servers and tools, configuration digest, observed native tool names and shutdown dispatch. The scout can retain complete fetched text with `draft_update`'s `addDocument` mutation, using a `suppliedDocument` with ID, role and asserted origin. Callers can also supply documents in the initial request through their own MCP adapter. Added documents count toward the recipient allowance and appear in `context.md`. Worker closure certifies release of local connections, not remote cancellation.

For `ready`, inspect `handoff.md` and the receipt for clarification, ambiguities, coverage limitations and the actual output paths. A material conflict with the assignment blocks dispatch even if byte verification passed. For `blocked`, inspect the reported draft and diagnostics; start a new authorized request or explicitly create a fresh manual draft. Failed or cancelled discovery does not provide transferable context.

Verify saved bytes with `verify --bundle /absolute/bundle --mode integrity`. Before making an unchanged-source reuse claim, run `verify --bundle /absolute/bundle --mode current --config /absolute/config.json`. The current check covers delivered local material and relevant comparisons, not every unselected file in the original discovery inventory. Neither operation modifies the bundle.

Send only the verified absolute path to `context.md` through the recipient integration's `inputFiles` argument. That file contains all selected material and the final original task and constraints. Keep `handoff.md`, `manifest.json` and the terminal receipt with the coordinator. Do not rewrite the packet in place or add a competing task attachment. Reserve any dispatch-message and attachment-wrapper overhead separately from smip's complete-file estimate.

The existing Pi integration reads attachments through its file-argument path. A downstream answer or delivery acknowledgement is separate from smip readiness. The operator must establish complete attachment delivery and normal recipient completion for the chosen integration; the smip receipt certifies only its own recorded work and saved packet.

From a source checkout, verify a saved capture of the constructed recipient user input against the context and complete processed CLI dispatch text:

```sh
node scripts/verify-live.mjs attachment \
  /exports/packet/context.md /work/recipient-user-input.txt \
  /work/recipient-dispatch-processed.txt /work/attachment-receipt.json
```

The dispatch file contains what the integration appended to the CLI input. An integration that delivers the short task as a file adds that file's wrapper and control instructions, so its processed dispatch differs from the raw tool task. Establish this expected text independently from the task artifact and documented integration behavior. The verifier compares the entire input exactly, including every appended suffix. Capture only recipient user text and completion metadata for this check. System instructions, credentials and thinking remain private. Measure all processed dispatch and wrapper overhead before claiming recipient fit under the configured estimate.
