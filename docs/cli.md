# Command line

The `mipmux` command runs the MCP server, prints the configuration and the available discovery models, and runs workspace, build, render and verification jobs from JSON files. [Configuration](configuration.md) describes the file every command reads.

Build with `npm run build`, then run `node dist/cli/main.js`. Every input path is absolute. Commands read the configuration file at `$XDG_CONFIG_HOME/mipmux/config.json`, or `~/.config/mipmux/config.json` when that variable is unset; `--config /absolute/file.json` selects another file. Progress goes to stderr; one-shot commands write a JSON result to stdout. MCP mode reserves stdout for protocol traffic.

```sh
node dist/cli/main.js mcp
node dist/cli/main.js config
node dist/cli/main.js models
node dist/cli/main.js workspace --spec /work/spec.json
node dist/cli/main.js tool read_file --workspace /work/spec.json --input /work/read.json
node dist/cli/main.js build --request /work/build.json > /work/terminal-receipt.json
node dist/cli/main.js render --request /work/render.json --draft /work/draft.json
node dist/cli/main.js verify --bundle /exports/packet --mode integrity
node dist/cli/main.js verify --bundle /exports/packet --mode current
node dist/cli/main.js cache invalidate --kind artifact --key <sha256>
node dist/cli/main.js cache invalidate --kind reuse --key <sha256>
```

## `config` and `models`

`config` prints the defaults that builds use: `{ "kind": "config", "path", "contextBudgetUnits", "defaultEnhancementMode", "tools", "discovery" }`, where `discovery` is `null` or `{ "model": "provider/model", "thinking", "allowedModels": ["provider/model", ...] }`. It prints no other paths, credentials or environment values, and starts nothing.

`models` prints the discovery models mipmux has credentials for: `{ "kind": "models", "models": ["provider/model", ...] }`, sorted. It lists them the way a discovery job sees them, in a worker given only `discovery.environment`, so an API key exported in your shell adds no models. The list comes from the providers built into mipmux's Pi SDK, with the overrides in `discovery.modelsPath` and the credentials in `discovery.authPath`; it reads no model catalog from the network. With `discovery.claudeCode` configured, it also lists the `claude-code/` models Claude Code offers your account, without a model request. Choose `discovery.model` and `discovery.allowedModels` from it.

## Input files and exit codes

The workspace file is a `WorkspaceSpec`. A build file contains `{ "workspace": <WorkspaceSpec>, "requestId": "caller-id", "request": <ContextBuildRequest> }`, with an optional `"discovery": { "model": "provider/model", "thinking": "low" }` that selects the job's discovery model and level from the allowed models. A render file contains `{ "workspace": <WorkspaceSpec>, "request": <ContextBuildRequest> }`; its draft file contains `{ "selections": [<SourceSelection>], "prompt": "Complete resulting prompt" }`. Omit `enhancementMode` and `budgetUnits` to use the configured defaults. Input files for `mipmux tool` must contain complete requests matching the exported exploration schemas. MCP and Pi discovery-agent calls accept the concise inputs described in [MCP tools](mcp-tools.md). Integrity verification needs only saved bundle files and Node. Build exits 0 for ready, 2 for blocked, 1 for failure and 130 for cancellation before publication. Save its complete stdout receipt before ending the workflow.

## Cache repair

Cache corruption and conflict diagnostics include `target: { kind, key }`; a builder job that fails on one carries the same `target` in its receipt. Pass that target's `kind` and `key` to `cache invalidate`, then repeat the failed operation. Artifact targets name extraction records; reuse targets name the saved file fingerprints that let a restarted server skip unchanged files. Library callers use `runtime.artifacts.invalidate(key)` for an artifact or `runtime.artifacts.invalidateReuse(key)` for reuse. Each method removes only its named record.
