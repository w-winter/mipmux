# omp-mipmux

omp-mipmux is the [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) version of [pi-mipmux](https://github.com/w-winter/mipmux/tree/main/integrations/pi#readme). Its `/mipmux` command opens a panel where you choose the folders that the agent's context packets come from, and set build preferences such as the budget and the discovery model. The extension applies these choices to the agent's `context_builder` and `context_prepare` calls before omp sends them to mipmux.

![The /mipmux panel in Pi: adding a root folder to the saved workspace, raising this session's budget to 245,000 units, and saving with Ctrl+S](https://github.com/user-attachments/assets/4c2b9b60-e184-4b83-99d1-6856f3b4925d)

The recording shows pi-mipmux in Pi. omp-mipmux opens the same panel in omp.

## Install

omp-mipmux needs mipmux connected to omp as an MCP server named `mipmux`, and the `mipmux` command on your PATH; the [mipmux quickstart](https://github.com/w-winter/mipmux#quickstart) covers installation and configuration. Add the server to `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "mipmux": { "command": "mipmux", "args": ["mcp"], "timeout": 999999 }
  }
}
```

omp measures `timeout` in milliseconds, and a build's wait can last minutes, so give it more than the longest wait you expect; `0` turns the timeout off. Then install the extension:

```sh
omp plugin install omp-mipmux
```

## Use

The panel, saved workspaces, ignore rules, preferences, server defaults and the footer item work as the [pi-mipmux README](https://github.com/w-winter/mipmux/tree/main/integrations/pi#choose-a-workspace) describes, with omp in place of Pi, apart from these differences:

- Saved workspaces and the footer setting are stored in `mipmux.json` in omp's agent directory: `~/.omp/agent`, the active profile's agent directory, or `$PI_CODING_AGENT_DIR`.
- omp's MCP support names the tools `mcp__mipmux_context_builder` and `mcp__mipmux_context_prepare`, with one underscore after `mipmux`. omp also accepts a call to `mcp__mipmux__context_builder`, with two underscores, as a call to the same tool, and the extension applies to it as well.
- The extension adds the selected workspace's declaration to the system prompt as a `<mipmux_workspace>` block.
- omp-mipmux has no `mipmux_wait` tool. The agent waits with `context_job`, and omp delivers a steering message sent during a wait when the wait returns.

## Development

```sh
npm ci
npm run typecheck
npm test
```

`src/extension.ts` and `src/routes.ts` belong to this package. `scripts/copy-shared.mjs` copies the modules it shares with pi-mipmux from `../pi/src` into `src`, where Git ignores the copies, so edit the originals in `../pi/src`. The type check and the tests run the copy first. The tests need Bun: one opens the panel with omp's terminal components, and one runs omp in RPC mode with a scripted model and a stand-in mipmux server.

To run the extension from a checkout instead of npm, install its one dependency, copy the shared modules, and link the folder:

```sh
npm ci --omit=dev
node scripts/copy-shared.mjs
omp plugin link .
```

Publish with `npm run release`, or check what it would publish with `npm run release -- --dry-run`. It copies the shared modules and publishes a staged copy of the package, because npm does not run a package's own scripts when `ignore-scripts` is set, as it is in this folder's `.npmrc`. The package is marked private so that a plain `npm publish` fails rather than shipping stale copies.
