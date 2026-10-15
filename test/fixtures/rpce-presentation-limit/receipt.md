# Frozen codemap presentation entry-limit reference

This fixture is a source reference for implementers comparing RPCE's limit on requests in a frozen codemap presentation. It compiles extracted Swift from RepoPrompt CE revision `43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3`. The oracle covers the guard that permits at most 4096 requests and classifies rejected requests as pending. It uses original grouping of ready results by root epoch. Admission means passing this guard into a modeled success return, not successful execution of the complete freeze operation.

## Reproduce

From `/Users/ww/smip`, run:

```sh
node test/fixtures/rpce-presentation-limit/generate.mjs /Users/ww/repoprompt-ce
node test/fixtures/rpce-presentation-limit/generate.mjs /Users/ww/repoprompt-ce --check
```

Node, `swiftc` and `trash` must be on `PATH`. The RPCE checkout must have the pinned HEAD and unchanged source files listed in `provenance.json`; the generator rejects a mismatch rather than resetting the checkout. Only this fixture directory is written. The generator compiles a standalone adapter executable, runs it with `inputs.json`, and uses `trash` to remove its temporary source, executable and module cache. The check invocation compares all generated products byte-for-byte.

`inputs.json` uses counts rather than thousands of file entries. `expected.json` records four direct guard cases and six cases that group ready candidates. Each grouped root reports its ready and readyNoSymbols input counts, the actual request count produced by the original grouping block, and the entry-guard result. `original-bodies.swift.txt` contains compiled excerpts with fixture declarations. `reference-only.swift.txt` contains uncompiled source dependencies; `provenance.json` records source paths, Git blob IDs, whole-file hashes, range hashes, compilation status and fixture hashes. `LICENSE` is the original Apache-2.0 license.

## Results and source boundary

The direct guard rejects zero requests as `emptyRequest`, admits 1 and 4096 requests, and rejects 4097 as `entryLimitExceeded(limit: 4096)`. Both rejection reasons classify as pending through the original selection classifier. Grouping an empty candidate list makes no freeze call; directly calling the guard with zero requests rejects them.

Two root epochs with 4096 ready requests each both pass, despite their combined count of 8192. With 4097 requests in one root and 1 in a second, the first root is rejected as pending and the healthy root still passes its own entry guard. These results establish grouping and guard independence; the fixture does not produce rendered output for the healthy root.

Injected completed demand results use either `ready` or `readyNoSymbols` as their artifact outcome. The original grouping includes both kinds. Cases admit 4095 ready plus 1 readyNoSymbols, reject 4096 ready plus 1 readyNoSymbols, and reject 4097 readyNoSymbols. The handle renderer, retained as uncompiled source, accepts only `.ready(artifact)` and returns nil for readyNoSymbols. These cases count nonrenderable ready outcomes before rendering. Terminal-unavailable demand results do not enter the `.ready` branch; acquisition of oversize, decodeFailed and parseFailed outcomes is outside the exercised input domain.

The compiled source ranges are `WorkspaceFileContextStore.swift:373,15004-15016`, `WorkspaceCodemapPresentationCoordinator.swift:435-458`, `MCPServerViewModel+SelectionCore.swift:324-327,591-600`, `WorkspaceCodemapPresentationModels.swift:35-38,93-112`, and `WorkspaceCodemapArtifactDemandModels.swift:37-41`. Full repository-relative paths and hashes are in `provenance.json`. Each range is verbatim, including indentation and final newline. Fixture declarations surround the original bodies. The original debug-only counter is excluded by compiling without `DEBUG`.

The exact execution boundary is after Store line 15016, the closing brace of the count guard. A fixture-only return creates an empty ready bundle there. Store line 15018 starts the unexecuted root-epoch checks; the remaining freeze implementation, including duplicate IDs, currentness, retained-record admission and lease retention, is reference data only. The original coordinator grouping executes, but its asynchronous root loop at lines 462-494 is replaced by a synchronous sorted loop that calls the entry guard for each group. String labels replace complete epoch and path values; tickets contain only deterministic file IDs and epoch labels; ready results contain outcome labels rather than real snapshots or handles.

The receipt proves neither full freeze success nor rendering, publication, provider replies, cancellation or demand retention. Pending is the freeze-issue classifier's result, not an observed MCP response or a guarantee that work remains retained. No application, provider or project build is involved.
