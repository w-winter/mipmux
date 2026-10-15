# Root-atomic codemap rendering reference

This fixture is for implementers comparing Context Builder codemap presentation with RepoPrompt CE (RPCE) revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. A frozen bundle is the ordered set of ready demand entries and handles for one root. The original renderer returns either all rendered entries for that bundle or one unavailable reason. The original coordinator retains successful results from independent roots.

## Reproduce

From the smip checkout, with Node, `swiftc` and `trash` on `PATH`, run:

```sh
node test/fixtures/rpce-root-presentation/generate.mjs /absolute/path/to/repoprompt-ce
node test/fixtures/rpce-root-presentation/generate.mjs /absolute/path/to/repoprompt-ce --check
```

The generator requires the pinned reference HEAD and byte-identical source files. It reads RPCE through Git and the working tree, compiles a standalone Swift executable inside this fixture directory, and runs it on `inputs.json`. Its `finally` block sends temporary source, executable and compiler caches to `trash`. It neither builds the project nor calls an app or provider. The check invocation compares every generated file, including `provenance.json`, byte-for-byte.

`adapter.swift` defines the modeled store and handle storage. `original-bodies.swift.txt` contains executable original excerpts inside fixture declarations. `reference-only.swift.txt` contains the unexecuted original freeze, currentness and ready-matching functions. `provenance.json` records exact inclusive source ranges, their compilation status and SHA-256 hashes, whole-source SHA-256 hashes, Git blob IDs, the combined compilation hash and hashes of the fixture files. `LICENSE` is the pinned Apache-2.0 license. `expected.json` has one compact JSON object per input case; each root reports its status and returned rendered paths, followed by the original missing-file diagnostics for the operation.

With Node v22.22.1 and Apple Swift 6.4 on arm64 macOS, the check command printed `"cases": 9` and `"result": "byte-for-byte identical"`. `provenance.json` records the SHA-256 of `expected.json`.

## Demonstrated behavior

`all-ready` renders all three files in root `a` and the healthy file in root `b`. The no-symbols cases put `readyNoSymbols` first, middle and last in root `a`. Every placement returns `noRenderableCodemap` for its named file and zero rendered entries for root `a`, including when earlier entries rendered successfully inside the original loop. Root `b` still returns `b/h.swift` in each case. The original missing-file classifier reports only the no-symbols file as unmapped; its supported siblings are pending because their rendered entries are missing from the failed bundle.

`multiple-no-symbols` supplies nonrenderable entries at both ends of root `a`. The first one is unmapped; the later nonrenderable entry remains pending with its other sibling because the renderer stops at the first failure.

`stale-middle` injects a failed currentness check before the second file renders. `revoked-middle` throws from the second handle's key access. `stale-on-revalidation` lets every file render, then fails the second file's currentness check in the renderer's final pass. Each failure discards all root `a` entries and reports its missing files as pending. Root `b` remains ready.

`nonrenderable-stale` makes the second artifact both stale and nonrenderable. Currentness fails before the renderer inspects its text, so every root `a` file is pending and none is terminal unmapped.

Compilation includes the complete original `renderCodemapPresentation` body in `WorkspaceFileContextStore.swift:15180-15253`. Grouping at `WorkspaceCodemapPresentationCoordinator.swift:435-458` and the root loop at 460-494 execute, including per-root issue handling and successful bundle accumulation. Methods for accessing handles at `WorkspaceCodemapLiveOverlayModels.swift:389-426` execute; the renderer at 411-426 returns nil unless the syntax outcome is `.ready(artifact)`. Original missing-file diagnostics and classification at `MCPServerViewModel+SelectionCore.swift:310-327,344-373,386-487` execute with the render classifier at 602-613. Candidate and freeze classifiers compile as dependencies but are not exercised. Full repository-relative paths and all additional compiled model, formatter, token-estimator and coverage ranges are in `provenance.json`.

## Adapter boundaries and unknowns

Inputs are already-ready demand results. Only `ready` and `readyNoSymbols` are accepted as input outcomes. The fixture constructs retained frozen bundles directly; it does not execute the original checks for admitting a frozen bundle. Terminal-unavailable oversize, decodeFailed and parseFailed acquisition outcomes are outside the input domain. Their presence in the compiled original outcome enum does not establish that they enter a frozen ready bundle.

Root epochs and artifact keys are short string labels. Tickets contain deterministic file IDs and root labels; logical paths contain display labels. Ready matching compares modeled entries and tickets instead of production identities, snapshots and generations. Currentness states in the input apply after the modeled freeze succeeds: `current` always passes, `stale` fails its first render check, and `staleOnRevalidation` passes once before failing the final pass. Handle storage returns a seeded syntax outcome or throws for `revoked`; it has no lock or retained lease owner. The supplied syntax artifacts contain a fixed API description and empty imports, formatted and counted by the extracted original methods. The output omits text, token counts and opaque bundle UUIDs to focus on root results.

The Swift-file support adapter accepts only the supplied supported `.swift` labels. Classifiers for automatic selection and issues from non-ready demands fail fast if reached. Ownership recording and phase notifications are no-ops, roots sort by label, and the operation adapter builds the rendered-file lookup used by the original missing-file classifier. Post-loop sorting, publication and MCP reply assembly are not executed. Pending and unmapped describe classifier results, not observed provider replies or guarantees of retained work.

The outer `withPresentation` attempt and publication loop is not executed. Selection replies that request a new presentation use the coordinator wrapper at lines 203–233 with `requestedCodemapCount: nil`. After retryable staleness survives both attempts, lines 271–286 can replace all root output with an incomplete presentation, including an otherwise healthy root. Healthy-root results in this fixture describe one render attempt, not the final reply after outer retry exhaustion. Nonrenderable text alone does not trigger that retry.

This fixture does not prove real cancellation, engine acquisition, security or root IO, authority or epoch validation, watcher behavior, lock-backed handle revocation, lease retention, publication or app runtime. It also does not exercise bundle-retention/metadata failures, artifact-key/outcome mismatch or concurrent invalidation. Stale and revoked states are deterministic injections, not evidence of transitions in the production lifecycle.
