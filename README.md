# mipmux

mipmux builds context packets for coding agents. You declare the folders a task involves and describe the task; mipmux's discovery agent selects the source files, line ranges, code maps (syntax summaries of files) and Git patches the task needs, and mipmux saves them with the task as one `context.md` file for a planning, review or investigation model to read. Packets are checked against the files on disk when they are prepared, so mipmux refuses a packet whose files have changed rather than delivering it. mipmux runs as a stdio MCP server, a command-line tool or a TypeScript library, on macOS and Linux.

mipmux is a headless port of the Context Builder in [RepoPrompt CE](https://github.com/repoprompt/repoprompt-ce) (RPCE). It carries RepoPrompt CE's Apache-2.0 code for ignore rules, code maps, search, file trees and packet formatting, with each change recorded in `docs/vendor-provenance.json`. Discovery runs on the SDK of [Pi](https://pi.dev), an open-source coding agent, or through Claude Code. mipmux is an independent project and is not affiliated with RepoPrompt.

## Status

mipmux is alpha software in regular use with Pi; its interfaces and configuration may change. It is tested on macOS arm64 and on Linux arm64 in Docker; Linux x64 has not been tested. Claude Code and Codex have each run the whole caller workflow. Discovery has run with real models through `openai-codex`, through Claude Code, and through OpenRouter with Gemini 3.8 Flash. There are no prebuilt binaries or npm packages yet, so you build mipmux from source.

## Compared with RepoPrompt CE

RepoPrompt CE is a macOS app, and its Context Builder works inside workspaces that you create and manage in the app. mipmux has no app or window. It runs on macOS and Linux, including remote machines, and any MCP client can call it. Each call declares the folders it needs: mipmux keeps an index for each set of folders while it runs and reuses its cache after a restart, so there is no list of workspaces to maintain. The cost is search speed, described under [Limits](#limits).

## Security

[SECURITY.md](SECURITY.md) lists what mipmux reads, writes, runs and connects to, including what its discovery agent sends to the model provider, and explains how to report a vulnerability.

## Requirements

- Node.js 22.23.4 or a later 22 release, 24.22.1 or a later 24 release, or 26.12.1 or later.
- Swift 6.2 or later, a C/C++ compiler, CMake, pkg-config and tar, to build mipmux's native Swift helper. On macOS, Xcode 26 or later, or its Command Line Tools, provides Swift and the compiler, and Homebrew provides CMake and pkg-config.
- Git, at `/usr/bin/git` unless the configuration names another path.
- For discovery, one of: a login to a model provider, stored in Pi's `auth.json` (see the quickstart); a provider's API key (see [Discovery with an API key](docs/configuration.md#discovery-with-an-api-key)); or Claude Code signed in with your Claude account or an API key, with the Claude Agent SDK installed next to mipmux (see [Claude Code discovery](docs/configuration.md#claude-code-discovery)).

## Quickstart

1. Build mipmux. The first native build downloads and compiles its dependencies, which takes several minutes.

   ```sh
   git clone https://github.com/w-winter/mipmux.git
   cd mipmux
   npm ci
   npm run build
   npm run build:native
   ```

2. Sign in to a model provider for discovery. mipmux reads provider credentials from Pi's `~/.pi/agent/auth.json`. If you already use Pi and are signed in, skip this step. To use a provider's API key instead, skip it too and follow [Discovery with an API key](docs/configuration.md#discovery-with-an-api-key). Otherwise start the Pi command-line tool that mipmux installed, run `/login`, choose a provider, then quit Pi:

   ```sh
   node_modules/.bin/pi
   ```

3. Configure discovery in `~/.config/mipmux/config.json`. Paths must be absolute. `modelsPath` names a model file; a file containing `{ "providers": {} }` selects Pi's built-in model list.

   ```json
   {
     "discovery": {
       "provider": "openai-codex",
       "model": "gpt-6.1-sol",
       "thinking": "medium",
       "modelsPath": "/home/you/.config/mipmux/models.json"
     }
   }
   ```

   To run discovery with Claude models through Claude Code instead, see [Claude Code discovery](docs/configuration.md#claude-code-discovery). Without a `discovery` entry, `context_builder` fails with `discoveryNotConfigured`. To select a packet's contents yourself instead, add `"tools": "full"`, which offers the exploration and manual-packet tools described under [Context packets](docs/packets.md). [Configuration](docs/configuration.md) lists every setting.

4. Connect your MCP client to `node /absolute/path/to/mipmux/dist/cli/main.js mcp`. If the client cannot find `node`, use its absolute path.

   Claude Code:

   ```sh
   claude mcp add --scope user mipmux -- node /absolute/path/to/mipmux/dist/cli/main.js mcp
   ```

   Codex, in `~/.codex/config.toml`:

   ```toml
   [mcp_servers.mipmux]
   command = "node"
   args = ["/absolute/path/to/mipmux/dist/cli/main.js", "mcp"]
   ```

   Pi, in `~/.pi/agent/mcp.json`, and other clients that read an `mcpServers` object:

   ```json
   {
     "mcpServers": {
       "mipmux": {
         "command": "node",
         "args": ["/absolute/path/to/mipmux/dist/cli/main.js", "mcp"]
       }
     }
   }
   ```

   To use a configuration file other than `~/.config/mipmux/config.json`, add `--config /absolute/path/config.json` after `mcp`.

## Using mipmux

When a client connects, mipmux sends it short instructions for building a packet, which most agents can follow without help. The [agent workflow](docs/workflow.md) is the complete guide; point your agent at it for its first run. The instructions tell agents to wait for a build in steps shorter than their client's tool-call limit, which is 60 seconds by default in Codex.

In Pi, the [pi-mipmux extension](integrations/pi/README.md) adds a `/mipmux` command for choosing a saved workspace and setting build preferences, such as the budget or discovery model, that apply to the agent's calls.

## Documentation

The [agent workflow](docs/workflow.md) and the server's instructions cover building a packet. These pages cover the rest:

- [Configuration](docs/configuration.md): every setting; discovery with a Pi login, an API key or Claude Code; MCP servers that discovery may use; and editing the discovery prompt.
- [MCP tools](docs/mcp-tools.md): the inputs, results and errors of every MCP tool.
- [Command line](docs/cli.md): the `mipmux` commands and their input files.
- [Workspaces and ignore rules](docs/workspaces.md): which files mipmux indexes, `.mipmux_ignore`, and the paths it never reads.
- [Context packets](docs/packets.md): the context request, selecting a packet's contents yourself, copy presets and settings, budgets, and checking and delivering saved packets.
- [TypeScript library](docs/library.md): running mipmux inside a Node.js program.
- [Building and testing](docs/development.md): the full build and test sequence, the native helper, local packages and Linux validation.

Contributors also have the [native and workspace contracts](docs/contracts.md) and the [discovery prompt bindings](docs/discovery-prompt-bindings.md), which record how mipmux corresponds to RepoPrompt CE's source.

## Limits

- Each search first checks the declared folders for changes, so a content search takes about 0.7 seconds in a workspace of about 1,000 files. RepoPrompt CE answers in tens of milliseconds because a file watcher keeps its index current. A discovery run makes a handful of searches, so this adds seconds to a run that takes minutes.
- The first index of a new set of folders takes 10 to 15 seconds for about 1,000 files, mostly to build code maps. Later refreshes take under half a second, and the first refresh after a restart about one second.
- Code maps cover `.c`, `.cpp`, `.cs`, `.go`, `.java`, `.js`, `.php`, `.py`, `.rb`, `.rs`, `.swift`, `.ts` and `.tsx` files. Other text files can be included in full or as line ranges. A code map is derived from syntax alone, so its symbols and referenced type names are hints, within the limits of the parser mipmux carries over from RepoPrompt CE.
- mipmux runs on macOS and Linux only.

## License

mipmux is licensed under the [Apache License 2.0](LICENSE). Its extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`, also under Apache-2.0, and `docs/vendor-provenance.json` records where each retained file came from and how it was changed. [Third-party notices](THIRD_PARTY_NOTICES.md) identify the licenses of the code mipmux includes.
