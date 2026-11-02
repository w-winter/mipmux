# omp-mipmux

omp-mipmux is the [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) version of [pi-mipmux](../pi/README.md). Its `/mipmux` command opens a panel where you choose the folders that the agent's context packets come from, and set build preferences such as the budget and the discovery model. The extension applies these choices to the agent's `context_builder` and `context_prepare` calls before omp sends them to mipmux.

## Install

omp-mipmux needs mipmux connected to omp as an MCP server named `mipmux`, and the `mipmux` command on your PATH. Add the server to `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "mipmux": { "command": "mipmux", "args": ["mcp"] }
  }
}
```

Install the extension from a mipmux checkout:

```sh
cd /absolute/path/to/mipmux/integrations/omp
npm ci --omit=dev
node scripts/copy-shared.mjs
omp plugin link .
```

`scripts/copy-shared.mjs` copies the modules this extension shares with pi-mipmux into its `src` folder. Run it again after updating the checkout.

## Use

The panel, saved workspaces, ignore rules, preferences, server defaults and the footer item work as the [pi-mipmux README](../pi/README.md#choose-a-workspace) describes, with omp in place of Pi, apart from these differences:

- Saved workspaces and the footer setting are stored in `mipmux.json` in omp's agent directory: `~/.omp/agent`, the active profile's agent directory, or `$PI_CODING_AGENT_DIR`.
- omp's MCP support names the tools `mcp__mipmux_context_builder` and `mcp__mipmux_context_prepare`, with one underscore after `mipmux`. omp also accepts a call to `mcp__mipmux__context_builder`, with two underscores, as a call to the same tool, and the extension applies to it as well.
- The extension adds the selected workspace's declaration to the system prompt as a `<mipmux_workspace>` block.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`src/extension.ts` and `src/routes.ts` belong to this package. `scripts/copy-shared.mjs` copies every other module from `../pi/src` into `src`, where Git ignores the copies, so edit the originals in `../pi/src`. The type check, the tests and `npm pack` run the copy first. The tests need Bun: one opens the panel with omp's terminal components, and one runs omp in RPC mode with a scripted model and a stand-in mipmux server.
