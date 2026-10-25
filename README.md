# mipmux

mipmux indexes explicit filesystem roots, provides source exploration, and prepares verified context packets on macOS and Linux. Use its library, stdio MCP server or CLI. Swift owns extraction and descriptor-relative filesystem access. TypeScript owns workspace policy, inventory generations, persistent artifacts, drafts, Git comparisons, rendering, and verification. An isolated Pi discovery agent can curate a draft through scoped tools, called directly or from Pi `codemode` scripts, before the parent verifies and publishes it.

A ready code map is a syntax-derived summary. Its symbols and referenced type names are structural hints, subject to the retained parser's limits and heuristics.

## Build and test

Install Node 22.22.1 or later, Swift 6.2 or later, a C/C++ compiler, CMake, pkg-config, and tar. The build downloads the pinned PCRE2 10.49 archive, verifies its checksum and packaged SLJIT files, builds its static width-8 library, and runs upstream tests. SwiftPM dependencies are pinned in `native/Package.resolved`.

```sh
npm ci --ignore-scripts
node scripts/build-native.mjs test
npm run verify:vendor
npm run typecheck
npm run build
node scripts/build-native.mjs build --configuration release
npm test
```

Run native commands through `scripts/build-native.mjs`. It supplies SwiftPM's explicit `--pkg-config-path`, verifies the private dependency files, checks the linked executable, and writes `linkage.json` beside the executable. A mismatched or interrupted dependency build fails with its directory path for inspection and explicit removal before rebuilding.

Search uses the native executable's Foundation and statically linked PCRE2 matching implementations. The native dependency receipt and linkage checks identify the engine used by both extraction and search.

The native executable is `native/.build/<platform>-<architecture>/<configuration>/MipmuxBridge`, with Node's platform and architecture names, such as `darwin-arm64` and `linux-arm64`. Its first argument is a process-generation identifier. Requests and responses use JSON Lines on stdin/stdout; each request includes that generation, wire version 1, and a request ID.

Release builds also copy the verified executable to `libexec/<platform>-<architecture>/MipmuxBridge`. Native filesystem tests retain synthetic files beneath the excluded `test-output/` directory for inspection.

```sh
target="$(node -p 'process.platform + "-" + process.arch')"
printf '%s\n' '{"wireVersion":1,"requestId":"describe","generation":"example","operation":{"kind":"describe"}}' |
  "native/.build/$target/debug/MipmuxBridge" example
```

`describe` reports supported extensions, extraction limits, decoder policy, regex-engine checks, and Swift's canonical pipeline identities. [The native contract](docs/contracts.md) describes acquisition, extraction, export, and cancellation.

## Local package

Create an unpublished package in an absolute output directory:

```sh
npm run package:local -- /var/tmp/mipmux-local-package
```

The command builds TypeScript and the native release executable, verifies source history, and packs the runtime files and notices through npm. `inventory.json` records archive and file hashes, sizes, `buildLockSHA256`, and the packaged executable's linked libraries. That digest identifies the package-lock.json used to build mipmux; installed dependency graphs have their own lockfiles and audit results. Release copies omit debug metadata and use portable compiler source paths. The native build directory retains the unstripped executable and its linkage receipt.

Install the resulting `.tgz` with `npm install --ignore-scripts /absolute/path/mipmux-0.1.0.tgz`. The installed CLI is available as `mipmux`. It runs the package's own `libexec/<platform>-<architecture>/MipmuxBridge` unless the configuration names another `nativeExecutable`. The package includes the discovery prompt and dependency identity beside its compiled modules.

## Workspace API

Importing `mipmux` starts no processes and creates no storage. Construct `MipmuxRuntime` with absolute cache/native paths, explicit native environment, credential-file exclusions, and a termination grace. Search uses the configured native executable. The cache directory must be private; source roots and the output directory must already exist.

```ts
import { MipmuxRuntime } from 'mipmux';

const runtime = new MipmuxRuntime({
  copyContext: {
    current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
    customizations: { includeFiles: null, includeUserPrompt: null,
      includeFileTree: null, fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
    codeMapsGloballyDisabled: false, activeGitRoot: null, presets: [],
  },
  contextBudgetUnits: 200000,
  defaultEnhancementMode: 'augment',
  cachePath: '/var/tmp/private-mipmux-cache',
  nativeExecutable: '/opt/mipmux/libexec/darwin-arm64/MipmuxBridge',
  nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'auto' },
  credentialPaths: [],
  terminationGraceMs: 1000,
});
const signal = new AbortController().signal;
try {
  const workspace = await runtime.declare({
    roots: [{ name: 'repo', absolutePath: '/repos/sample' }],
    exclusions: [],
    outputRoot: '/exports/mipmux',
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

Workspace visibility follows RPCE's ignore rules. Git repositories apply a mandatory `.gitignore` filter, including ancestor controls when a loaded root is below the repository root. Global patterns, `.repo_ignore` and `.cursorignore` supply additional ordered rules. Optional `ignoreSettings` in the host configuration or runtime options sets `global` pattern text and the booleans `respectRepoIgnore`, `respectCursorignore` and `enableHierarchicalIgnores`. Omission uses RPCE's global defaults, including dependency and cache directories, with all three switches enabled.

Explicit exclusions govern every root, including overlapping roots. Git administration paths, `.env` files, configured credential paths (including ones that do not exist yet), the cache, and the admitted output directory are excluded. Absolute denies also apply through declared root aliases, including aliases of containing roots. Descendant source symlinks are skipped. This protects excluded material; it cannot identify arbitrary secrets renamed into permitted files.

`runtime.artifacts.invalidate(keyDigest)` removes a reported corrupt artifact explicitly. Corrupt/conflicting artifacts cause errors rather than cache misses. [Workspace and exploration contracts](docs/contracts.md#workspace-generations-and-exploration) describe identities, coverage, query semantics, and pagination.

## Manual context packets

The MCP and Pi `manage_selection` tool supports get, set, add, remove, preview, promote, demote and clear operations. File and directory paths can use declared root aliases; absolute file paths also support explicit access to ignored regular files within the workspace. Managed-only files remain accessible by exact path and are excluded from ordinary discovery. Full-file additions retain existing slices, while promotion restores full content. Codemap-only additions and demotion select manual mode; promotion retains the current mode. See the [selection contracts](docs/contracts.md#public-selection-and-explicit-registration) for transaction and registration ownership.

A supported file with no rendered codemap remains selected. Selection replies identify it in `code_structure.unmapped_paths`; it contributes no source or codemap body. Pending extraction left by cancellation can complete on a later explicit codemap request.

Set runtime or host `copyContext.codeMapsGloballyDisabled` to `true` to disable codemap generation and output, including cached signatures. `get_code_structure` returns an unavailable result with issue `codemaps_disabled`. Source reads and searches remain available. Packets and exports can include full files and slices. Codemap-only selection mutations are rejected; optional initial codemap membership remains recorded, and required codemaps return `codemapUnavailable`.

Create a draft from a workspace handle after declaring its roots and output directory. Creation reconciles the workspace and acquires required material before returning. `initialSelection` captures mutable starting sources and automatic/manual codemap mode; `requiredSources` declares evidence that must remain selected. Automatic initial selection accepts full files and slices; manual selection also accepts codemaps. Required codemaps select manual mode. A draft owns its selections and pins exact source bytes; close each draft when finished. Closing the workspace handle does not revoke an existing draft.

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

`copyPreset` selects `standard`, `manual`, `diffFollowUp` or `codeReview`, a UUID, or a preset name. An object with `id`, `kind` or `name` selects explicitly by those fields, in that priority. Kind lookup uses the original built-in; UUID and explicit-name lookup use the configured catalog with built-in overrides. Standard includes ordinary context; Review includes nonblank selected Git patches. Diff Follow-Up delivers Git evidence, caller constraints and literal user instructions. Use optional source selections to set its Git scope; required sources or documents produce `copyPresetRequiredMaterialConflict`.

Packets contain evidence, fixed constraints and the resulting task prompt. The calling agent system supplies the recipient's role separately, for example through a Pi subagent definition. Send the verified `context.md` as that recipient's input.

The required runtime or host `copyContext` configures current settings, Manual working-copy overrides, selected saved-prompt IDs, an active Git root and preset records. Each draft captures that context at admission. The [copy settings example](docs/context-protocol.md#copy-settings-and-presets) lists every field. Manual supports no codemaps, automatic related maps, selected-file maps or complete maps across all declared roots. Selected-file mode can replace directly selected bodies with maps; slice-only entries retain their slices. Required bodies that a setting would exclude or replace return `copyPresetRequiredMaterialConflict`.

Use `prompt` with `input: { op: "list_presets" }` to list the raw configured catalog; no draft is needed. Use `input: { op: "export", path: "interim.md", copy_preset: "manual" }` and the owning `draftId` to write a complete UTF-8 context file under the declared output root. `copy_preset` is optional and applies only to that export. Existing files and symlink destinations are rejected. The draft remains inspectable, editable and finalizable. Cancellation before writing creates no destination; cancellation after a successful write can leave the complete file while returning cancellation.

Manual complete Git uses the explicit `activeGitRoot` and already-local comparison refs. A null root produces no complete diff. Missing local refs fail explicitly. Refresh remote-tracking refs yourself before requesting a comparison that needs them. Nonblank selected patch artifacts take precedence over both selected and complete Git acquisition.

Review and Diff Follow-Up export nonblank selected patch artifacts first. When none supplies text, they acquire a Git diff for the selected full files and slices. A slice includes its file's complete diff. The optional `reviewGitBase` sets the comparison: omission, blank text and case-insensitive `HEAD` compare the working tree against captured HEAD; another ref compares against its merge base with captured HEAD. Each checkout's comparison is frozen before diff acquisition. Configure `git.executable` for Git-backed selections. Partial repository or comparison failures appear as explicit diagnostics in the Git section. Caller-supplied `patches` remain complete and follow the selected or automatic Git text in every preset.

A draft's prompt starts as `task`. A Context Builder build starts its draft with an empty prompt instead, like a new RPCE tab, and discovery receives `task`, followed by any `discoveryHints`, as its instructions. Set `defaultEnhancementMode` in the host configuration to `fullRewrite`, `augment` or `preserve`; omission selects Augment. A request's optional `enhancementMode` overrides that default. Discovery uses literal prompt operations: `set` replaces the current text, `append` adds text exactly, `clear` empties it and `get` returns it. Rewrite delivers the replacement; Augment keeps the starting prompt at the beginning and adds discoveries; Preserve leaves the starting prompt unchanged. These modes guide discovery rather than restricting the caller's explicit prompt operations. Caller constraints and required inputs remain fixed. Optional source updates use `upsert` with a `full`, `slices`, or `codemap` selection; `remove` removes an explicit optional selection. Slice ranges use one-based inclusive endpoints and descriptions. Upsert replaces the file's representation. Required representations cannot be removed or changed.

Drafts start in automatic mode unless a required source is a codemap. Automatic mode adds related codemaps for full and sliced sources. A codemap upsert or `clearCodemaps` enters manual mode; `clearSources` restores the required source baseline. Clear operations retain documents, patches and the current prompt. [Selection contracts](docs/contracts.md#drafts-and-material-ownership) describe promotion, inferred-source removal and comparison recovery.

Use `addDocument` with a `suppliedDocument` and a unique ID to retain complete text fetched during curation. Added documents are immutable and count toward the assembly budget.

`draft.inspect` provides `metadata`, `costs`, and `material` views with `maxOutputBytes` and `continuation`. Material inspection names a material ID from metadata, such as `document:prior-report`. It pages complete lines against a material digest. Updates return the committed revision, changed-item costs, total measurement, and unresolved diagnostics. If detail does not fit, the receipt identifies incomplete detail and the costs view supplies the complete breakdown.

Set `contextBudgetUnits` in the host configuration to the default assembly budget. A request's optional `budgetUnits` overrides it, whether smaller or larger. For example, a 200000-unit default permits an explicitly requested 500000-unit build. The scout receives `max(0, budgetUnits - 1500)`, following RPCE's reserve. Complete-packet measurement and publication enforce the resolved `budgetUnits`. The estimate is `floor(21 × UTF-8 bytes / 80)`, rather than an exact tokenizer count. Over-budget results report the excess and retain all material for explicit correction.

Ready output contains `context.md`, `handoff.md`, and `manifest.json` beneath the declared output directory. Send only `context.md` to the recipient. Its sections contain the file map and codemaps, full and sliced file blocks, selected Git evidence, caller constraints and the current literal prompt. Supplied documents appear as full-file blocks labeled with their role, origin and ID. The coordinator records retain the original request, current prompt, byte spans, hashes, accounting and complete comparison receipts, including scope, resolved revisions, policies and target fingerprints. Output creation is exclusive. Readback and final source checks precede manifest publication.

Import `verifyBundle` to verify saved bytes without source access. `verifyCurrentBundle(directory, runtime, signal)` additionally reopens recorded roots and checks delivered local material, controlling ignore files, current configured denies, native codemap keys, and relevant comparisons. Unselected files are examined only when a requested live comparison needs them. Keep the saved packet unchanged after verification.

### Documents and patches

`localDocument` acquires a complete root-qualified document under workspace policy. `suppliedDocument` retains exact caller text and an asserted origin; that origin grants no filesystem access. All rendered text must be lossless UTF-8, with original BOMs and newline bytes retained. NUL-containing source is binary and cannot be selected as text or a codemap.

Supplied patches retain complete UTF-8 patch text, declared changed paths, source history, and target byte/mode evidence. Every selected source in an associated root must have matching target evidence. This verifies source coherence, not the external producer's underlying comparison.

Configure `git: { executable: '/absolute/path/to/git' }` on `MipmuxRuntime` for local patches. `PatchInput` supports explicit worktree, staged, and commit-endpoint comparisons, with an explicit commit or empty baseline and an all-paths or prefix-path scope. Worktree requests choose whether to include untracked files. The helper reads repository objects and generates patches from captured byte/mode pairs in private directories. Patches preserve deletion, addition, binary, empty-file, executable-mode, and quoted-name changes. Local symlink, gitlink, and unmerged entries produce errors. Staged and historical comparisons check selected supporting sources against the target as well as changed files.

## CLI and MCP

Build with `npm run build`, then run `node dist/cli/main.js`. Every input path is absolute. Commands read the configuration file at `$XDG_CONFIG_HOME/mipmux/config.json`, or `~/.config/mipmux/config.json` when that variable is unset; `--config /absolute/file.json` selects another file. Progress goes to stderr; one-shot commands write a JSON result to stdout. MCP mode reserves stdout for protocol traffic.

```sh
node dist/cli/main.js mcp
node dist/cli/main.js workspace --spec /work/spec.json
node dist/cli/main.js tool read_file --workspace /work/spec.json --input /work/read.json
node dist/cli/main.js build --request /work/build.json > /work/terminal-receipt.json
node dist/cli/main.js render --request /work/render.json --draft /work/draft.json
node dist/cli/main.js verify --bundle /exports/packet --mode integrity
node dist/cli/main.js verify --bundle /exports/packet --mode current
node dist/cli/main.js cache invalidate --kind artifact --key <sha256>
node dist/cli/main.js cache invalidate --kind membership --key <sha256>
```

The workspace file is a `WorkspaceSpec`. A build file contains `{ "workspace": <WorkspaceSpec>, "requestId": "caller-id", "request": <ContextBuildRequest> }`. A render file contains `{ "workspace": <WorkspaceSpec>, "request": <ContextBuildRequest> }`; its draft file contains `{ "selections": [<SourceSelection>], "prompt": "Complete resulting prompt" }`. Omit `enhancementMode` and `budgetUnits` to use the configured defaults. Input files for `mipmux tool` must contain complete requests matching the exported exploration schemas. MCP and Pi discovery-agent calls accept the concise inputs described below. Integrity verification needs only saved bundle files and Node. Build exits 0 for ready, 2 for blocked, 1 for failure and 130 for cancellation before publication. Save its complete stdout receipt before ending the workflow.

Cache corruption and conflict diagnostics include `target: { kind, key }`; a builder job that fails on one carries the same `target` in its receipt. Pass that target's `kind` and `key` to `cache invalidate`, then repeat the failed operation. Artifact targets name extraction records; membership targets name workspace inventory records. Library callers use `runtime.artifacts.invalidate(key)` for an artifact or `runtime.artifacts.invalidateMembership(key)` for membership. Each method removes only its named record.

Every configuration field is optional. Enabling `discovery` requires `provider`, `model`, `thinking` and `modelsPath`, the path of the model file described below. A file sets only what differs from the defaults:

```json
{
  "contextBudgetUnits": 200000,
  "defaultEnhancementMode": "augment",
  "credentialPaths": ["/private/notes/secrets.json"],
  "discovery": {
    "provider": "openai-codex",
    "model": "gpt-6.1-sol",
    "thinking": "medium",
    "modelsPath": "/private/mipmux/models.json",
    "promptTemplatePath": "/private/mipmux/discovery.md",
    "policy": { "compaction": { "reserveTokens": 9000 } }
  }
}
```

Omitted fields take these values:

| Field | Default |
|---|---|
| `contextBudgetUnits` | `200000` estimated units for a complete packet |
| `defaultEnhancementMode` | `augment` |
| `credentialPaths` | none. Listed files and directories are excluded from context collection, in addition to the configuration, authentication and model files |
| `copyContext` | RPCE's default copy state: Auto file tree, automatic codemaps, no Git inclusion, no customizations and no custom presets |
| `ignoreSettings` | RPCE's default ignore behavior |
| `cachePath` | `~/Library/Caches/mipmux` on macOS; elsewhere `$XDG_CACHE_HOME/mipmux` or `~/.cache/mipmux` |
| `nativeExecutable` | the package's `libexec/<platform>-<architecture>/MipmuxBridge` |
| `nativeEnvironment` | none |
| `terminationGraceMs` | `1000` |
| `git` | `{ "executable": "/usr/bin/git" }`. Set `null` to work without Git |
| `defaultMaxOutputBytes` | `48000`, which keeps a default exploration reply below Pi's 50 KiB tool-output limit |
| `discovery` | `null`, for model-free use |
| `discovery.authPath` | `auth.json` in `$PI_CODING_AGENT_DIR`, or in `~/.pi/agent` when that variable is unset |
| `discovery.promptTemplatePath` | the shipped `dist/prompts/discovery.md` |
| `discovery.environment` | none |
| `discovery.mcp` | `null` |
| `discovery.policy` | Pi's defaults, merged field by field with the file's overrides: retries `enabled`, `maxRetries: 3`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60000`; provider requests `timeoutMs` equal to `httpIdleTimeoutMs`, `maxRetries: 0`, `maxRetryDelayMs: 60000`; compaction `enabled`, `reserveTokens: 16384`, `keepRecentTokens: 20000`; `transport: "auto"`, `httpIdleTimeoutMs: 300000`, `websocketConnectTimeoutMs: 15000` |

Discovery never warms prompt caches, because warming is billed; `policy.cacheWarming` accepts only `"off"`. `copyContext` accepts RPCE's copy-state record, with `current`, `customizations`, `codeMapsGloballyDisabled`, `activeGitRoot` and `presets`, when you need custom presets or customizations. Library hosts pass the resolved form, with every field explicit, to `createMcpServer`.

Set `discovery.promptTemplatePath` to an absolute path to your editable discovery template. Install the shipped `dist/prompts/discovery.md` into an existing operator-owned directory using exclusive creation:

```sh
node --input-type=module <<'JS'
import { constants, copyFileSync } from 'node:fs';
copyFileSync('/opt/mipmux/dist/prompts/discovery.md',
  '/private/mipmux/discovery.md', constants.COPYFILE_EXCL);
JS
```

Edit that copy's named policy sections using the [template format](docs/discovery-prompt-bindings.md#template-format). Swift composes Rewrite, Augment or Preserve, review and clarification guidance from the template and captured facts. Both system policy and startup metadata use the budget after one 1500-unit reserve; complete-packet measurement uses the configured assembly allowance. Startup data contains the file map, current prompt and discovery instructions. A runtime observation supplies routing, revision, fixed constraints and evidence accounting.

Each job admits one regular UTF-8 file and retains that snapshot through all its turns. Later jobs observe edits to the same path. Use atomic file replacement when updating policy during active work. Missing files, invalid encoding or template syntax, and nonregular paths produce admission errors before Pi discovery starts. Package builds update the shipped default; your configured copy remains operator-owned.

The terminal receipt records `templateVersion`, the template path and raw-byte `template.identity`, and the rendered system policy's `policyIdentity`. Each identity contains SHA-256 and UTF-8 byte count. SDK working-directory framing, tools and startup messages are outside the policy digest.

The worker reads the authorized authentication and model files; these paths and the host's configuration file are excluded from source discovery. The model file accepts a `providers` object with optional `baseUrl` and per-model `modelOverrides` containing `contextWindow` and `maxTokens`. Use `{ "providers": {} }` to select the bundled catalog explicitly. Other fields in model configuration and command-valued credentials are rejected. Supply the exact physical provider/model and supported thinking level; configuration errors require correction before another request.

### Discovery MCP access

Set `discovery.mcp` to `{ "agentDirectory": "/private/mipmux/scout-mcp" }` to let discovery use selected tools from HTTP MCP servers. Use a dedicated directory with permissions `0700` containing `mcp.json`; set `mcp` to `null` to use only mipmux tools. Replace the URL and tool name in this example with your server's values:

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

For OAuth, sign in before starting discovery jobs using the Pi executable from mipmux's dependency installation. Run `mcp list` to check the connection and find exact tool names:

```sh
cd /private/mipmux/scout-mcp
PI_CODING_AGENT_DIR="$PWD" /opt/mipmux/node_modules/.bin/pi mcp login tickets
PI_CODING_AGENT_DIR="$PWD" /opt/mipmux/node_modules/.bin/pi mcp list
```

If discovery reports `mcpToolsUnavailable`, use `mcp list` in the private directory to diagnose connection or sign-in problems. See the [discovery contract](docs/contracts.md#discovery-and-client-ownership) for configuration options and lifecycle details.

### Caller MCP interface

MCP clients launch the `mcp` command over stdio. The server exposes `workspace_declare`, `workspace_refresh`, `workspace_close`; `get_file_tree`, `get_code_structure`, `file_search`, `read_file`, `git`; `prompt`, `manage_selection`, `draft_create`, `draft_inspect`, `draft_update`, `draft_validate`, `draft_finalize`, `draft_dispose`; `context_builder`, `context_builder_wait`, `context_builder_result`, `context_builder_cancel`, `context_builder_dispose`; and `context_prepare`. `tools/list` supplies their schemas. Each result is one text block of compact JSON; `get_code_structure` instead returns its rendered view as text, with the complete evidence as structured content. Workspace, draft and job IDs belong to the connected client.

Exploration calls use `workspaceId` and a tool-specific `input`. Request a file tree with only `{ "workspaceId": "..." }`, read with `{ "workspaceId": "...", "input": { "root": "app", "path": "src/main.ts" } }`, or search with `{ "workspaceId": "...", "input": { "query": { "text": "greet" } } }`. These tools are available independently of context-builder jobs.

File trees use RPCE's renderer. `type: "roots"` lists physical roots; `type: "files"` supports `mode: "auto"`, `"full"`, `"folders"` or `"selected"`. The default is files in automatic mode. To inspect a directory, supply `scope: { root: "repo", directory: { kind: "descendant", path: "src" } }`; use `{ kind: "root" }` for a whole named root. `maxDepth` starts at folder depth zero and retains selected descendants beyond the cutoff. A star marks selected implementation and a plus marks available code-map structure. Selected mode requires an owned manual `draftId`. Tree pages contain complete rendered lines; follow `continuation` to obtain the rest.

Git queries use the configured Git executable. For status, log, show and blame, select checkouts with `repositories: [{ root: "repo" }]`. Add a selector's root-relative `path` to target a nested repository, or its absolute `worktree` to select an advertised same-repository checkout after identity checks. A declared subroot resolves its owning checkout. Selectors retain their order and deduplicate checkouts; status returns one result per checkout, while history operations use the first checkout and warn when multiple were selected. Linked-worktree results include checkout metadata and warnings.

Call `git` with `input: { op: "status", repositories: [{ root: "repo" }] }` for branch/tracking metadata and sorted staged, modified and untracked paths. Use `op: "log"` for the latest ten commits; `count` and an operation-level `path` restrict history. Use `input: { op: "blame", repositories: [{ root: "repo" }], path: "src/main.ts", lines: "1-20" }` for line attribution. Log/blame paths are relative to the declared root for a plain selector, or to the chosen checkout for a nested-repository/worktree selector. File paths remain subject to workspace policy. Use `op: "show", ref: "HEAD", detail: "full"` with the same selector for commit metadata, file statistics and complete patch hunks. `detail` defaults to `"summary"`; `"files"` includes per-file statistics, and `"patches"` requests the same complete hunks as `"full"`. Log, blame and show disable Git's textconv path. Status can execute repository-local clean/process filters, so use trusted repository Git configurations. The complete reply must fit `maxOutputBytes`.

Without `repositories`, workspace calls use the first declared root that resolves to a checkout. Calls owned by a draft instead use its initially elected checkouts: status can inspect all of them, while log, show and blame require an explicit selector when several were elected. An empty or unavailable initial target requires explicit selectors.

Use `input: { op: "diff", root: "repo", compare: "uncommitted", detail: "full" }` to inspect changes across the owning checkout. Staged, unstaged, revision and merge-base comparisons are supported. Optional `path`/`paths` accept checkout-relative Git globs and exclusions or absolute literal paths. Optional `worktree` selects an advertised same-repository checkout after identity checks. Protected endpoints are omitted and listed in `exclusions`; ordinary file tools remain scoped to declared roots. Diff compares captured source bytes in a private worktree. Git configuration must be trusted because clean/process filters may execute programs.

Reads default to the whole file. Structure requires `seeds` and defaults to `expand: "none"` and depth 1. Search defaults to automatic mode and regex inference, case-insensitive matching, no filters, zero surrounding context, and snippets rather than count-only output. Use `query.kind: "literal"` to select literal interpretation, `query.kind: "regex"` for PCRE2 or `query.kind: "glob"` for path globs; glob searches select path mode. Omit `continuation` for the first page.

Local patch inputs can use a declared root below its owning Git checkout. Comparison scope and receipt paths are relative to that declared root, while patch headers retain the checkout-relative prefix needed by `git apply`. Only files beneath the declared root participate in the comparison.

Structural queries use the owned draft's full/sliced selection when `seeds` is omitted; supply `draftId` beside `input` in MCP. Explicit `seeds` accepts up to 256 file or directory selectors. Files use `{ kind: "file", root: "repo", path: "src/main.ts" }`; directories use `{ kind: "directory", root: "repo", directory: { kind: "root" } }` or a descendant directory reference. Queries accept optional `expand: "uses"`, `"used_by"` or `"both"`, and `depth` from 1 to 4. `signatures` defaults to `true`; `size` defaults to `"medium"` and also accepts `"small"` or `"large"`. Results include root-local graph evidence, unresolved references, seed/index states and admitted signatures. Text responses use RPCE's graph/signature presentation; structured MCP results retain all returned evidence. `summary.tokens` counts admitted signatures and separators.

MCP puts optional `maxOutputBytes` beside `input`; omitted caps use the host default. Draft inspection/update calls use `draftId` and `input` with the same outer cap. The byte limit covers the serialized result, including the structured content of a structure query. The small `outputBudgetTooSmall` control diagnostic is the documented cap exception. Pi discovery-agent exploration uses the same input defaults and requires an explicit `maxOutputBytes` inside its input.

`context_builder` takes `workspaceId`, `requestId` and `request`. Repeating a request ID with identical input returns the same job; different input fails. Wait with `{ "jobId": "...", "durationMs": 10000 }`; timeout or cancellation of that wait leaves the job running. Cancel the job explicitly with `context_builder_cancel`. Closing the connection or runtime cancels and joins active work. A claimed publication finishes before shutdown returns.

A ready job snapshot's `bundle` is a bundle receipt rather than the manifest. It gives the bundle `directory`, the `context.md` path and identity, the accounting, one entry per delivered material (representation, path or ID, origin and estimated units), omitted sources and the resulting prompt. `draft_finalize` returns the same receipt without the prompt. `context_prepare` returns it with `added` and `removed` entries, relative to the saved bundle, in place of the complete material list. Ready and blocked snapshots give the number of discovery completions and their summed token `usage` (`input`, `output`, `cacheRead` and `cacheWrite`, as the provider reports them); each completion matched the effective model, or the job would have failed. Failed and cancelled snapshots keep the complete completion records, each with its own `usage`. The complete `manifest.json` stays in the bundle directory.

`context_prepare` publishes a new bundle from a saved one with a replacement prompt and makes no model call. It takes `workspaceId`, `bundle` (the saved bundle directory relative to the workspace output root), `prompt` (the complete final task, delivered verbatim as user instructions) and a new `outputName`. The workspace must declare the roots and output root that built the bundle. mipmux reads the saved files through its native reader, which refuses symlinks and paths outside the output root. It verifies the bundle, checks its evidence against current files, and repeats that check before publishing the new manifest. The new bundle keeps the saved evidence, constraints and formatting. When only the prompt changes, the saved budget does not limit the packet: its allowance rises as far as the new prompt needs. A `budgetUnits` value sets a budget the packet must fit instead, and a packet over it returns `blocked` with `overBudget`. A changed file fails with `sourceChanged` and its path. Ready replies are bundle receipts.

Set `refresh: true` to rebuild the packet from current files instead, with the same selection, required inputs and preset. Adding `requiredSources`, `documents` or `patches` also rebuilds it. A rebuild reads files the way draft finalization does and makes no model call.

`remove` and `demote` trim the packet and also rebuild it. Each takes material paths as receipts list them: `root/path` for a file, or a Git artifact's alias. `remove` drops optional files and Git artifacts. `demote` replaces optional full files and slices with their codemaps. Like demotion in `manage_selection`, it selects manual codemaps, so codemaps added automatically drop out and appear under `removed`. Required material cannot be removed or demoted. A path that names no saved material, appears twice, or names material these edits cannot change returns `invalidSelection`, which lists each problem.

A bundle keeps its selected Git artifacts unless `remove` names them. Each artifact is a diff captured at discovery, so while any remain, other edits require the saved evidence to still match current files, and `refresh: true` returns `refreshRequiresDiscovery`. Changed code under review needs a new Context Builder run.

The terminal receipt separates requested, locally dispatched, SDK-reported and independently returned model identities. It records the prompt hash, `buildLockSHA256`, the effective model record and thinking/recovery policy, ordinary and summary completions with their token usage, and local settlement. `buildLockSHA256` identifies mipmux's build lockfile; audit the installed graph separately when deploying a local package. Endpoint and header values are represented by hashes rather than copied into the receipt. Codex's independent server identity is unavailable; provider-internal attempts may be unobserved. Local closure does not establish remote cancellation or billing cessation. Only a verified ready bundle is transferable context. See [the context protocol](docs/context-protocol.md) for delivery and receipt capture.

Library hosts call `runtime.createClient(runner)` with a `DiscoveryRunner`, or null for manual-only work. The default library entry loads neither Pi nor MCP. `mipmux/mcp` exports `createMcpServer` and `serveMipmuxStdio`; factory construction registers handlers and validates configuration without opening workspaces or starting discovery.

## Linux validation and runtime

```sh
docker build -f test/linux/Dockerfile -t mipmux-validation .
docker run --rm mipmux-validation
```

The image for validation fixes Swift 6.2.4 on Ubuntu Noble and Node 22.22.1 by image digest. It builds dependencies and executables inside Linux. The release executable dynamically requires the Swift runtime, Foundation, Dispatch, Foundation ICU, glibc, libstdc++, and libgcc supplied by that environment. The exact linked-library inventory is in `linkage.json`; PCRE2 is statically linked. A machine running the executable must supply those runtime libraries.

## Source history

The extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`. `docs/vendor-provenance.json` records original hashes, retained destinations, moved declaration ranges, and adaptations. Verification covers the hashes of retained files, dependency pins, generated metadata, notices, and the 1,000-line ceiling for handwritten code. [Third-party notices](THIRD_PARTY_NOTICES.md) identify the licenses.
