# TypeScript library

mipmux can run inside a Node.js program instead of as an MCP server or command. The library declares workspaces, explores them and builds packets; a host that wants discovery or an MCP server adds them explicitly.

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

The [workspace rules](workspaces.md) describe which files a workspace includes.

`runtime.artifacts.invalidate(keyDigest)` removes a reported corrupt artifact explicitly. Corrupt/conflicting artifacts cause errors rather than cache misses. [Workspace and exploration contracts](contracts.md#workspace-generations-and-exploration) describe identities, coverage, query semantics, and pagination.

## Packets

Drafts, copy presets, budgets and verification are described in [Context packets](packets.md), whose examples use this API.

## Discovery and MCP

Library hosts call `runtime.createClient(runner)` with a `DiscoveryRunner`, or null for manual-only work. The default library entry loads neither Pi nor MCP. `mipmux/mcp` exports `createMcpServer` and `serveMipmuxStdio`; factory construction registers handlers and validates configuration without opening workspaces or starting discovery.
