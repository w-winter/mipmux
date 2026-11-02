# Outer codemap presentation retry reference

This executable reference is for implementers comparing Context Builder presentation with RepoPrompt CE (RPCE) revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. It executes the outer retry and publication wrapper around scripted render attempts. A publication receipt identifies a presentation that the wrapper asks the Store to revalidate after calling the operation. The operation represents reply or export assembly; its value can be discarded when publication is stale.

## Reproduce

From the mipmux checkout, with Node, `swiftc` and `trash` on `PATH`, run:

```sh
node test/fixtures/rpce-presentation-retry/generate.mjs /absolute/path/to/repoprompt-ce
node test/fixtures/rpce-presentation-retry/generate.mjs /absolute/path/to/repoprompt-ce --check
```

The path names a RepoPrompt CE checkout at the pinned revision. The generator checks its HEAD, Git blobs and working-file bytes before extracting source. It compiles only a standalone fixture executable and runs `inputs.json`. All generated files, temporary Swift source, executable and compiler caches stay inside this reference directory. A `finally` block sends the temporary directory to `trash`. Generation performs no project builds or tests, app or provider calls, Git index changes or commits.

`original-bodies.swift.txt` contains literal compiled source ranges inside fixture declarations. `reference-only.swift.txt` contains uncompiled caller and adapter context. `provenance.json` records whole-source SHA-256 hashes and Git blob IDs, exact inclusive ranges and hashes, compilation status, fixture hashes and the combined Swift compilation hash. `git hash-object --stdin` computes each fixture's blob ID without writing objects. `LICENSE` is the original Apache-2.0 license. The artifact list excludes its own manifest to avoid a circular hash; the generator prints the manifest's hash and blob ID. `inputs.json` and `expected.json` contain one compact object per case. Operation snapshots show entries, coverage, issues and an optional receipt; `outcome` names the returned operation or propagated error.

With Node v22.22.1 and Apple Swift 6.4 on arm64 macOS, the check command printed `"cases": 12` and `"result": "byte-for-byte identical"`. `expected.json` has SHA-256 `e2d8e207b86905a75075acf728e32c769fd14c70b268aaabed85ea5fd4967e10` and Git blob ID `9ae364f0371ab75da57d1d88a685b1b49aacc35f`.

## Original code and caller distinction

The compiled coordinator ranges are policy and waiter at 3-50, ownership at 52-113, attempt model at 126-132, intent wrapper at 208-233, generic wrapper at 235-345, release at 849-857, coverage at 859-880, incomplete publication at 882-892, prior-stale coverage at 894-916 and retryable-stale classification at 918-947. These are inclusive line numbers in `Sources/RepoPrompt/Infrastructure/WorkspaceContext/Presentation/WorkspaceCodemapPresentationCoordinator.swift` in the pinned checkout. Original operation models, ticket and ownership-result models, and freeze/render reason enums also compile; their paths and ranges are in `provenance.json`.

`Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+SelectionCore.swift:651-738` resolves selection, usage and the presentation plan once before calling the intent wrapper. That wrapper supplies constant intent, root scope and display names on both attempts, with `requestedCodemapCount: nil`. The reference compiles both wrapper overloads and invokes the intent overload for every `selection:nil` case. Selection resolution and accounting themselves are uncompiled context.

The generic wrapper allows at most two attempts. Retryable issues cause the first attempt's resources to be released before retry, if the shared deadline has not been reached. After retryable issues survive the second attempt, nil requested count causes `incompletePublication` to replace all output, including healthy-root entries. `noRenderableCodemap` alone is not a retryable issue.

The alternate case supplies count 2 directly through the generic overload. This models the export context supported by `Sources/RepoPrompt/Features/AgentMode/Services/AgentContextExportResolver.swift:575-593,907-914`: selected usage with an exact intent can provide a non-nil unique file count. It is not the default caller for selection or an execution of the full exporter. The first attempt is stale; the second has one healthy entry and no new render issue. `preservingPriorStaleCoverage` adds the prior publication-stale issue and partial coverage because the result is smaller than the requested count. The non-nil count and nonempty result allow that entry to reach the operation and current publication check.

## Cases and traces

- `first-stale-then-ready` releases the first attempt before making the second; only the second presentation reaches the operation and current publication check.
- `both-stale-nil-discards-healthy` scripts `b/h.swift` in both attempts. The only operation receives zero entries, unavailable coverage, a publication-stale issue for root `a` and no receipt.
- `nonrenderable-only-no-retry` invokes the operation once with an empty unavailable presentation and its original nonrenderable issue. There is one attempt and no publication check.
- `publication-stale-then-current` calls the operation before each publication check. The first operation's value is discarded; the second is returned. `publication-stale-both` calls the operation a third time with an incomplete presentation after both original values fail publication.
- `shared-deadline-second-exhausts-remainder` advances the controlled clock by 9000 ms in the first attempt and 1000 ms in the second. Both attempts receive deadline 10000; the second starts with 1000 ms remaining. `deadline-prevents-second-attempt` advances to the deadline in the first attempt and invokes the incomplete operation immediately.
- `make-error-releases`, `make-cancellation-releases`, `operation-error-releases` and `operation-task-cancellation-releases` record ownership before failing or cancelling. Original release drains all resources; the wrapper propagates the scripted error or `CancellationError`. Task cancellation occurs inside the operation before it returns, so the wrapper's subsequent cancellation check rejects its value.
- `alternate-export-count-preserves-prior-stale` demonstrates the non-nil count behavior described above. Its operation context is the second preparation, labeled `alternate#2`.

Every attempt records two demand tickets, one created and one joined, and two bundles. The trace shows bundles released in acquisition order, followed by tickets sorted by retain ID, even though tickets were recorded in reverse order. `remainingResources` is zero on every case. Each case runs in a separate Swift task so cancellation cannot cancel later cases.

## Exact adapters and limits

`models.swift` defines a fixture-local `ContinuousClock` that shadows `Swift.ContinuousClock` and the model values consumed by the original code. `adapter.swift` scripts the attempts and operation results. The original wrapper text is unchanged and constructs one clock before its loop. The injected waiter advances integer milliseconds immediately. Scripted `makePresentation` calls this waiter to represent elapsed readiness work. The original default policy supplies the production allowance of 10000 ms for readiness; no policy values are changed. This proves deadline reuse and retry gating in the wrapper under a controlled clock. It does not execute the original demand/wait loop or prove production scheduling or an end-to-end MCP duration bound. The fixture's coordinator runs on the main actor to serialize scripted state; scheduling in production remains unproven.

`makePresentation` returns input entry labels and the chosen render issue, or throws after recording resources. The original helper calculates coverage. Receipt presence and Store publication dispositions are scripted. The Store adapter removes IDs of modeled resources when the original coordinator calls release or cancellation. Original ownership record/drain and coordinator release execute; production Store cancellation, retained leases and engine cleanup do not. Publication receipts have synthetic IDs and empty candidate, demand-ticket and bundle metadata. The adapter assumes their validity instead of executing real currentness checks.

Root epochs and artifact keys are strings, bundle IDs are UUIDs and logical paths contain only their display labels. Rendered entries have synthetic file IDs, text and token counts; the adapter does not validate them against retained tickets. Frozen entries and automatic receipts are empty placeholder types; automatic coverage, automatic issues, demand-ready state and unavailable reasons contain only the members needed to compile the excerpts. Automatic selection, candidate construction, freeze admission, root rendering, identity/generation checks and concurrent invalidation are not executed. The original classifier for retryable staleness compiles in full, but only render `staleCurrentness`, render `noRenderableCodemap` and publication staleness are exercised. No result is claimed for its other issue variants.

The operation adapter records its input and returns a numbered value, throws a named error, or cancels its current task and returns. The publication hook records its invocation. No accounting, real reply assembly, external side effect or provider behavior is represented. Errors during preparation, cancellation during an actual wait and concurrency inside Store release remain unproven.

`test/fixtures/rpce-root-presentation/receipt.md` separately describes per-attempt rendering. Its healthy-root results concern one attempt; this reference establishes when the outer wrapper discards those results. Neither reference alone executes the complete selection-to-reply path.
