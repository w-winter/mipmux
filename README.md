# smip

smip indexes explicit filesystem roots, provides source exploration, and prepares verified context packets on macOS and Linux. Use its library, stdio MCP server or CLI. Swift owns extraction and descriptor-relative filesystem access. TypeScript owns workspace policy, inventory generations, persistent artifacts, drafts, Git comparisons, rendering, and verification. An isolated Pi discovery agent can curate a draft through scoped tools before the parent verifies and publishes it.

A ready code map is a syntax-derived summary. Its symbols and referenced type names are structural hints, subject to the retained parser's limits and heuristics.

## Build and test

Install Node 22.22.1 or later, Swift 6.2 or later, a C/C++ compiler, CMake, pkg-config, and tar. The build downloads the pinned PCRE2 10.49 archive, verifies its checksum and packaged SLJIT files, builds its static width-8 library, and runs upstream tests. SwiftPM dependencies are pinned in `native/Package.resolved`.

```sh
npm ci --ignore-scripts
node scripts/build-native.mjs test
npm run verify:vendor
npm run typecheck
npm run build
node test/linux/setup-search.mjs
node scripts/build-native.mjs build --configuration release
npm test
```

Run native commands through `scripts/build-native.mjs`. It supplies SwiftPM's explicit `--pkg-config-path`, verifies the private dependency files, checks the linked executable, and writes `linkage.json` beside the executable. A mismatched or interrupted dependency build fails with its directory path for inspection and explicit removal before rebuilding.

The search tests require Cargo/Rust 1.93.0 and an audited ripgrep executable. `test/linux/setup-search.mjs` prepares the test prerequisite on macOS or Linux beneath the ignored `.smip-work/test-ripgrep/` directory, linking the private PCRE2 10.49 archive. It records source, lockfile, executable, dependency, linkage, and toolchain identities in `receipt.json` there, and runs the PCRE2 Rust binding tests, including JIT matching. `SMIP_TEST_RG` selects an explicit test executable; otherwise tests use that prepared location.

Ripgrep 15.2.0's `--pcre2-version` prints the Rust bindings' 10.45 constants even when linked to PCRE2 10.49. The prerequisite receipt retains that output verbatim and records the linked engine through build evidence. Production hosts must supply an audited executable. Preflight checks whether the configured executable supports PCRE2; the build audit establishes which dependency it uses.

The native executable is `native/.build/<platform>-<architecture>/<configuration>/SmipBridge`, with Node's platform and architecture names, such as `darwin-arm64` and `linux-arm64`. Its first argument is a process-generation identifier. Requests and responses use JSON Lines on stdin/stdout; each request includes that generation, wire version 1, and a request ID.

Release builds also copy the verified executable to `libexec/<platform>-<architecture>/SmipBridge`. Native filesystem tests retain synthetic files beneath the excluded `test-output/` directory for inspection.

```sh
target="$(node -p 'process.platform + "-" + process.arch')"
printf '%s\n' '{"wireVersion":1,"requestId":"describe","generation":"example","operation":{"kind":"describe"}}' |
  "native/.build/$target/debug/SmipBridge" example
```

`describe` reports supported extensions, extraction limits, decoder policy, regex-engine checks, and Swift's canonical pipeline identities. [The native contract](docs/contracts.md) describes acquisition, extraction, export, and cancellation.

## Local package

Create an unpublished package in an absolute output directory:

```sh
npm run package:local -- /var/tmp/smip-local-package
```

The command builds TypeScript and the native release executable, verifies source history, and packs the runtime files and notices through npm. `inventory.json` records archive and file hashes, sizes, `buildLockSHA256`, and the packaged executable's linked libraries. That digest identifies the package-lock.json used to build smip; installed dependency graphs have their own lockfiles and audit results. Release copies omit debug metadata and use portable compiler source paths. The native build directory retains the unstripped executable and its linkage receipt.

Install the resulting `.tgz` with `npm install --ignore-scripts /absolute/path/smip-0.1.0.tgz`. The installed CLI is available as `smip`. Set `nativeExecutable` in the host configuration to the installed package's absolute `libexec/<platform>-<architecture>/SmipBridge` path. Cache, source roots, output, search, Git, and authentication paths remain explicit host inputs. The package includes the discovery prompt and dependency identity beside its compiled modules.

## Workspace API

Importing `smip` starts no processes and creates no storage. Construct `SmipRuntime` with absolute cache/native paths, explicit native environment, credential-file exclusions, and a termination grace. Add `search: { executable }` to enable search. The cache directory must be private; source roots and the output directory must already exist.

```ts
import { SmipRuntime } from 'smip';

const runtime = new SmipRuntime({
  contextBudgetUnits: 200000,
  cachePath: '/var/tmp/private-smip-cache',
  nativeExecutable: '/opt/smip/libexec/darwin-arm64/SmipBridge',
  nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'auto' },
  credentialPaths: [],
  terminationGraceMs: 1000,
});
const signal = new AbortController().signal;
try {
  const workspace = await runtime.declare({
    roots: [{ name: 'repo', absolutePath: '/repos/sample' }],
    exclusions: [],
    outputRoot: '/exports/smip',
  }, signal);
  await workspace.refresh(signal);
  const operation = await workspace.openOperation(signal);
  try {
    const result = await operation.readFile({
      root: 'repo', path: 'README.md', start_line: null, offset: null, limit: null,
      maxOutputBytes: 12000, continuation: null,
    });
    console.log(result);
  } finally {
    await operation.close();
    await workspace.close();
  }
} finally {
  await runtime.close();
}
```

Declaration starts warming. `refresh` registers a freshness barrier and joins shared work; a scan that started earlier is followed by a coalesced reconciliation. `openOperation` pins the current settled inventory. Closing one handle leaves other handles and admitted operations usable. Every operation must be closed, and runtime closure cancels and joins its owned work.

An operation provides `readFile`, `getFileTree`, `getCodeStructure`, and `fileSearch`. Their exported schemas define closed request objects. Reads/searches verify source and controlling-policy identities; changed inputs require a new reconciled request. Tree and structural queries use the pinned inventory. Read, tree and search pages return continuations; keep the same request settings when following them. Structural queries return a complete size-bounded graph reply. Increase `maxOutputBytes` or narrow the query when that reply cannot fit.

Repository-local `.gitignore` files and explicit exclusions govern every root, including overlapping roots. Git administration paths, `.env` files, configured credential paths (including ones that do not exist yet), the cache, and the admitted output directory are excluded. Absolute denies also apply through declared root aliases, including aliases of containing roots. Descendant symlinks are skipped. This protects excluded material; it cannot identify arbitrary secrets renamed into permitted files.

`runtime.artifacts.invalidate(keyDigest)` removes a reported corrupt artifact explicitly. Corrupt/conflicting artifacts cause errors rather than cache misses. [Workspace and exploration contracts](docs/contracts.md#workspace-generations-and-exploration) describe identities, coverage, query semantics, and pagination.

## Manual context packets

Create a draft from a workspace handle after declaring its roots and output directory. Creation reconciles the workspace and acquires required material before returning. A draft owns its selections and pins exact source bytes; close each draft when finished. Closing the workspace handle does not revoke an existing draft.

```ts
const draft = await workspace.createDraft({
  task: 'Review the implementation and identify correctness risks.',
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

`task` records the original prompt; `enhancementMode` is `fullRewrite`, `augment` or `preserve`. Discovery uses literal prompt operations: `set` replaces the current text, `append` adds text exactly, `clear` empties it and `get` returns it. Rewrite delivers the replacement; Augment preserves the original at the beginning and adds discoveries; Preserve leaves the original unchanged. These modes guide discovery rather than restricting the caller's explicit prompt operations. Caller constraints and required inputs remain fixed. Optional source updates use `upsert` with a `full`, `slices`, or `codemap` selection; `remove` removes an explicit optional selection. Slice ranges use one-based inclusive endpoints and descriptions. Upsert replaces the file's representation. Required representations cannot be removed or changed.

Drafts start in automatic mode unless a required source is a codemap. Automatic mode adds related codemaps for full and sliced sources. A codemap upsert or `clearCodemaps` enters manual mode; `clearSources` restores the required source baseline. Clear operations retain documents, patches and the current prompt. [Selection contracts](docs/contracts.md#drafts-and-material-ownership) describe promotion, inferred-source removal and comparison recovery.

Use `addDocument` with a `suppliedDocument` and a unique ID to retain complete text fetched during curation. Added documents are immutable and count toward the assembly budget.

`draft.inspect` provides `metadata`, `costs`, and `material` views with `maxOutputBytes` and `continuation`. Material inspection names a material ID from metadata, such as `document:prior-report`. It pages complete lines against a material digest. Updates return the committed revision, changed-item costs, total measurement, and unresolved diagnostics. If detail does not fit, the receipt identifies incomplete detail and the costs view supplies the complete breakdown.

Set `contextBudgetUnits` in the host configuration to the maximum assembly budget. Each request supplies numeric `budgetUnits`; larger values fail with `assemblyBudgetExceeded`. The scout receives `max(0, budgetUnits - 1500)`, following RPCE's reserve. Complete-packet measurement and publication use the requested `budgetUnits`. The estimate is `floor(21 × UTF-8 bytes / 80)`, rather than an exact tokenizer count. Over-budget results report the excess and retain all material for explicit correction.

Ready output contains `context.md`, `handoff.md`, and `manifest.json` beneath the declared output directory. Send only `context.md` to the recipient. A tree identifies selected material, and each body has a heading with its path or supplied ID. Material bodies appear in fenced blocks, followed by caller constraints and a final `user_instructions` section containing the current literal prompt. Patch summaries identify the comparison meaning, scope, requested and resolved revisions, worktree paths, coverage and exclusions. The coordinator records retain the original request, current prompt, byte spans, hashes, accounting and complete comparison receipts, including payload identities, per-path policies and target fingerprints. Output creation is exclusive. Readback and final source checks precede manifest publication.

Import `verifyBundle` to verify saved bytes without source access. `verifyCurrentBundle(directory, runtime, signal)` additionally reopens recorded roots and checks delivered local material, controlling ignore files, current configured denies, native codemap keys, and relevant comparisons. Unselected files are examined only when a requested live comparison needs them. Keep the saved packet unchanged after verification.

### Documents and patches

`localDocument` acquires a complete root-qualified document under workspace policy. `suppliedDocument` retains exact caller text and an asserted origin; that origin grants no filesystem access. All rendered text must be lossless UTF-8, with original BOMs and newline bytes retained. NUL-containing source is binary and cannot be selected as text or a codemap.

Supplied patches retain complete UTF-8 patch text, declared changed paths, source history, and target byte/mode evidence. Every selected source in an associated root must have matching target evidence. This verifies source coherence, not the external producer's underlying comparison.

Configure `git: { executable: '/absolute/path/to/git' }` on `SmipRuntime` for local patches. `PatchInput` supports explicit worktree, staged, and commit-endpoint comparisons, with an explicit commit or empty baseline and an all-paths or prefix-path scope. Worktree requests choose whether to include untracked files. The helper reads repository objects and generates patches from captured byte/mode pairs in private directories. Patches preserve deletion, addition, binary, empty-file, executable-mode, and quoted-name changes. Local symlink, gitlink, and unmerged entries produce errors. Staged and historical comparisons check selected supporting sources against the target as well as changed files.

## CLI and MCP

Build with `npm run build`, then run `node dist/cli/main.js`. Every input/configuration path is absolute. Progress goes to stderr; one-shot commands write a JSON result to stdout. MCP mode reserves stdout for protocol traffic.

```sh
node dist/cli/main.js mcp --config /etc/smip/config.json
node dist/cli/main.js workspace --spec /work/spec.json --config /etc/smip/config.json
node dist/cli/main.js tool read_file --workspace /work/spec.json --input /work/read.json --config /etc/smip/config.json
node dist/cli/main.js build --request /work/build.json --config /etc/smip/config.json > /work/terminal-receipt.json
node dist/cli/main.js render --request /work/render.json --draft /work/draft.json --config /etc/smip/config.json
node dist/cli/main.js verify --bundle /exports/packet --mode integrity
node dist/cli/main.js verify --bundle /exports/packet --mode current --config /etc/smip/config.json
node dist/cli/main.js cache invalidate --kind artifact --key <sha256> --config /etc/smip/config.json
node dist/cli/main.js cache invalidate --kind membership --key <sha256> --config /etc/smip/config.json
```

The workspace file is a `WorkspaceSpec`. A build file contains `{ "workspace": <WorkspaceSpec>, "requestId": "caller-id", "request": <ContextBuildRequest> }`. A render file contains `{ "workspace": <WorkspaceSpec>, "request": <ContextBuildRequest> }`; its draft file contains `{ "selections": [<SourceSelection>], "prompt": "Complete resulting prompt" }`. Every context request includes `enhancementMode`. Input files for `smip tool` must contain complete requests matching the exported exploration schemas. MCP and Pi discovery-agent calls accept the concise inputs described below. Integrity verification needs only saved bundle files and Node. Build exits 0 for ready, 2 for blocked, 1 for failure and 130 for cancellation before publication. Save its complete stdout receipt before ending the workflow.

Cache corruption and conflict diagnostics include `target: { kind, key }`; a builder job that fails on one carries the same `target` in its receipt. Pass that target's `kind` and `key` to `cache invalidate`, then repeat the failed operation. Artifact targets name extraction records; membership targets name workspace inventory records. Library callers use `runtime.artifacts.invalidate(key)` for an artifact or `runtime.artifacts.invalidateMembership(key)` for membership. Each method removes only its named record.

Host configuration uses this shape. The numbers are example host choices, not model-derived limits. `search` and `git` can each be null or `{ "executable": "/absolute/path" }`. Set `discovery` to null for model-free use.

```json
{
  "cachePath": "/var/tmp/private-smip-cache",
  "nativeExecutable": "/opt/smip/libexec/darwin-arm64/SmipBridge",
  "nativeEnvironment": { "REPOPROMPT_PCRE2_JIT": "auto" },
  "terminationGraceMs": 1000,
  "credentialPaths": [],
  "search": null,
  "git": null,
  "defaultMaxOutputBytes": 12000,
  "contextBudgetUnits": 200000,
  "discovery": {
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinking": "medium",
    "authPath": "/private/smip/auth.json",
    "modelsPath": "/private/smip/models.json",
    "promptPath": "/private/smip/discovery.md",
    "mcp": null,
    "environment": {},
    "policy": {
      "retry": {
        "enabled": true,
        "maxRetries": 3,
        "baseDelayMs": 2000,
        "maxAgentDelayMs": 60000,
        "provider": { "timeoutMs": 300000, "maxRetries": 0, "maxRetryDelayMs": 60000 }
      },
      "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
      "transport": "auto",
      "httpIdleTimeoutMs": 300000,
      "websocketConnectTimeoutMs": 15000,
      "cacheWarming": "off"
    }
  }
}
```

Set `discovery.promptPath` to the absolute path of an editable Markdown file beginning with `# smip discovery v1` followed by LF. For a source checkout, select the absolute path to `prompts/discovery-v1.md`. For an installed package, copy `dist/prompts/discovery-v1.md` from the package to a file you own, such as `/private/smip/discovery.md`, and select that path. Each job reads the file once and records its raw-byte SHA-256 as `promptSHA256`. Edits apply to the next job on the running server; an admitted job keeps its original prompt. Missing, nonregular, invalid UTF-8, or wrong-version prompt files fail before worker startup. Prompt instructions guide curation; tool permissions and bundle publication are controlled by the server.

The worker reads the authorized authentication and model files; these paths and the host's configuration file are excluded from source discovery. The model file accepts a `providers` object with optional `baseUrl` and per-model `modelOverrides` containing `contextWindow` and `maxTokens`. Use `{ "providers": {} }` to select the bundled catalog explicitly. Other fields in model configuration and command-valued credentials are rejected. Supply the exact physical provider/model and supported thinking level; configuration errors require correction before another request.

### Discovery MCP access

Set `discovery.mcp` to `{ "agentDirectory": "/private/smip/scout-mcp" }` to let discovery use selected tools from HTTP MCP servers. Use a dedicated directory with permissions `0700` containing `mcp.json`; set `mcp` to `null` to use only smip tools. Replace the URL and tool name in this example with your server's values:

```json
{
  "mcpServers": {
    "tickets": {
      "url": "https://tickets.example.com/mcp",
      "exposure": "hidden",
      "toolExposure": { "read_ticket": "direct" }
    }
  }
}
```

For OAuth, sign in before starting discovery jobs using the Pi executable from smip's dependency installation. Run `mcp list` to check the connection and find exact tool names:

```sh
cd /private/smip/scout-mcp
PI_CODING_AGENT_DIR="$PWD" /opt/smip/node_modules/.bin/pi mcp login tickets
PI_CODING_AGENT_DIR="$PWD" /opt/smip/node_modules/.bin/pi mcp list
```

If discovery reports `mcpToolsUnavailable`, use `mcp list` in the private directory to diagnose connection or sign-in problems. See the [discovery contract](docs/contracts.md#discovery-and-client-ownership) for configuration options and lifecycle details.

### Caller MCP interface

MCP clients launch the `mcp` command over stdio. The server exposes `workspace_declare`, `workspace_refresh`, `workspace_close`; `get_file_tree`, `get_code_structure`, `file_search`, `read_file`, `git`; `prompt`, `draft_create`, `draft_inspect`, `draft_update`, `draft_preview`, `draft_validate`, `draft_finalize`; and `context_builder`, `context_builder_wait`, `context_builder_result`, `context_builder_cancel`. `tools/list` supplies their schemas. Workspace, draft and job IDs belong to the connected client.

Exploration calls use `workspaceId` and a tool-specific `input`. Request a file tree with only `{ "workspaceId": "..." }`, read with `{ "workspaceId": "...", "input": { "root": "app", "path": "src/main.ts" } }`, or search with `{ "workspaceId": "...", "input": { "query": { "text": "greet" } } }`. These tools are available independently of context-builder jobs.

File trees use RPCE's renderer. `type: "roots"` lists physical roots; `type: "files"` supports `mode: "auto"`, `"full"`, `"folders"` or `"selected"`. The default is files in automatic mode. To inspect a directory, supply `scope: { root: "repo", directory: { kind: "descendant", path: "src" } }`; use `{ kind: "root" }` for a whole named root. `maxDepth` starts at folder depth zero and retains selected descendants beyond the cutoff. A star marks selected implementation and a plus marks available code-map structure. Selected mode requires an owned manual `draftId`. Tree pages contain complete rendered lines; follow `continuation` to obtain the rest.

Git queries use the configured Git executable. Call `git` with `input: { op: "status", root: "repo" }` for branch/tracking metadata and sorted staged, modified and untracked paths from one observation of the checkout. Call `git` with `input: { op: "log", root: "repo" }` for the latest ten commits, or add `count` and a root-relative `path` to restrict history. Use `input: { op: "blame", root: "repo", path: "src/main.ts", lines: "1-20" }` for line attribution. A root below the checkout top level resolves its owning repository. File paths remain subject to workspace policy. Use `input: { op: "show", root: "repo", ref: "HEAD", detail: "full" }` for commit metadata, file statistics and complete patch hunks. `detail` defaults to `"summary"`; `"files"` includes per-file statistics, and `"patches"` requests the same complete hunks as `"full"`. Log, blame and show disable Git's textconv path. Status can execute repository-local clean/process filters, so use trusted repository Git configurations. The complete reply must fit `maxOutputBytes`.

Reads default to the whole file. Structure requires `seeds` and defaults to `expand: "none"` and depth 1. Search defaults to literal content, case-insensitive substring matching, no filters, zero surrounding context, and snippets rather than count-only output. Use `query.kind: "regex"` for PCRE2 or `query.kind: "glob"` for path globs; glob searches default to path mode. Omit `continuation` for the first page.

Structural queries use the owned draft's full/sliced selection when `seeds` is omitted; supply `draftId` beside `input` in MCP. Explicit `seeds` accepts up to 256 file or directory selectors. Files use `{ kind: "file", root: "repo", path: "src/main.ts" }`; directories use `{ kind: "directory", root: "repo", directory: { kind: "root" } }` or a descendant directory reference. Queries accept optional `expand: "uses"`, `"used_by"` or `"both"`, and `depth` from 1 to 4. `signatures` defaults to `true`; `size` defaults to `"medium"` and also accepts `"small"` or `"large"`. Results include root-local graph evidence, unresolved references, seed/index states and admitted signatures. Text responses use RPCE's graph/signature presentation; structured MCP results retain all returned evidence. `summary.tokens` counts admitted signatures and separators.

MCP puts optional `maxOutputBytes` beside `input`; omitted caps use the host default. Draft inspection/update calls use `draftId` and `input` with the same outer cap. The byte limit includes the serialized text and structured result together. The small `outputBudgetTooSmall` control diagnostic is the documented cap exception. Pi discovery-agent exploration uses the same input defaults and requires an explicit `maxOutputBytes` inside its input.

`context_builder` takes `workspaceId`, `requestId` and `request`. Repeating a request ID with identical input returns the same job; different input fails. Wait with `{ "jobId": "...", "durationMs": 10000 }`; timeout or cancellation of that wait leaves the job running. Cancel the job explicitly with `context_builder_cancel`. Closing the connection or runtime cancels and joins active work. A claimed publication finishes before shutdown returns.

The terminal receipt separates requested, locally dispatched, SDK-reported and independently returned model identities. It records the prompt hash, `buildLockSHA256`, the effective model record and thinking/recovery policy, ordinary and summary completions, and local settlement. `buildLockSHA256` identifies smip's build lockfile; audit the installed graph separately when deploying a local package. Endpoint and header values are represented by hashes rather than copied into the receipt. Codex's independent server identity is unavailable; provider-internal attempts may be unobserved. Local closure does not establish remote cancellation or billing cessation. Only a verified ready bundle is transferable context. See [the context protocol](docs/context-protocol.md) for delivery and receipt capture.

Library hosts call `runtime.createClient(runner)` with a `DiscoveryRunner`, or null for manual-only work. The default library entry loads neither Pi nor MCP. `smip/mcp` exports `createMcpServer` and `serveSmipStdio`; factory construction registers handlers and validates configuration without opening workspaces or starting discovery.

## Linux validation and runtime

```sh
docker build -f test/linux/Dockerfile -t smip-validation .
docker run --rm smip-validation
```

The image for validation fixes Swift 6.2.4 on Ubuntu Noble and Node 22.22.1 by image digest. It builds dependencies and executables inside Linux. The release executable dynamically requires the Swift runtime, Foundation, Dispatch, Foundation ICU, glibc, libstdc++, and libgcc supplied by that environment. The exact linked-library inventory is in `linkage.json`; PCRE2 is statically linked. A machine running the executable must supply those runtime libraries.

## Source history

The extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`. `docs/vendor-provenance.json` records original hashes, retained destinations, moved declaration ranges, and adaptations. Verification covers the hashes of retained files, dependency pins, generated metadata, notices, and the 1,000-line ceiling for handwritten code. [Third-party notices](THIRD_PARTY_NOTICES.md) identify the licenses.
