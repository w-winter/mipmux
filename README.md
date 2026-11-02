# mipmux

> A mip multiplexer (from *multum in parvo*, "many things in a small place", as in [mipmaps](https://web.archive.org/web/20140414134825/http://staff.cs.psu.ac.th/iew/cs344-481/p1-williams.pdf))

mipmux prepares context packets for language models: single Markdown files that give a model what it needs to reason about a task effectively, and as little else as possible, within a specified token budget. A packet holds the task description and the source it concerns, as whole files, slices (line ranges), or code maps (outlines of a file's declarations, such as its classes, methods and functions, with their signatures), along with any Git patches and documents the task depends on.

A discovery agent assembles each packet as it explores the folders you declare, follows referenced types and helpers into other files, and fits its selection to the budget, preferring complete files and falling back to slices and code maps. By default, it appends what it learned to the task description: the architecture of the relevant code, how the selected files relate, and ambiguities the description leaves open. It can instead rewrite the task description into a fuller and more precise problem statement. The agent runs through either [Pi](https://pi.dev) or the Claude Agent SDK.

mipmux records each packet's contents and the exact sources they came from. The coding agent that called mipmux then gives a saved packet its final instructions with `context_prepare`, which makes no model call. It refuses a packet whose sources changed since discovery or, on request, rebuilds the same selection from the current files.

mipmux is a headless port of the Context Builder in [RepoPrompt CE](https://github.com/repoprompt/repoprompt-ce), whose discovery agent curates context and precisifies task descriptions in the above-described way. It runs on macOS and Linux as a Model Context Protocol (MCP) server over standard input/output, a command-line tool or a TypeScript library. Its ignore rules, code maps, search, file trees and packet formatting derive from RepoPrompt CE's Apache-2.0 code. mipmux is an independent project and is not affiliated with RepoPrompt.

## Status

mipmux is alpha software; its interfaces and configuration may change. The full test suite has been exercised on macOS arm64 and Linux arm64 in Docker. Linux x64 has passed native tests under emulation, but full-suite validation is incomplete. Live checks have covered the build, wait and prepare workflow from Claude Code and Codex clients, and discovery through Pi's `openai-codex` provider, Claude Code, and OpenRouter with Gemini 3.8 Flash. Installation currently requires a source build; prebuilt binaries and published npm packages are not yet available.

## Compared with RepoPrompt CE

RepoPrompt CE manages workspaces in a macOS app. mipmux accepts workspace declarations from a command-line program or an MCP client that supports stdio servers. A workspace declaration names source folders, an output folder and optional exclusions; `context_builder` and `context_prepare` take it directly. Repeating the declaration on the same connection reuses the workspace, and a persistent cache helps avoid rereading unchanged files after a restart. The optional Pi extension saves named declarations for reuse across sessions. mipmux checks for file changes when requested rather than maintaining RepoPrompt CE's watched index; see [Limits](#limits).

## Security

[SECURITY.md](SECURITY.md) lists what mipmux reads, writes, runs and connects to, including what its discovery agent sends to the model provider, and explains how to report a vulnerability.

## Requirements

- Node.js 22.23.4 or a later 22 release, 24.22.1 or a later 24 release, or 26.12.1 or later.
- Swift 6.2 or later, a C/C++ compiler, CMake, pkg-config and tar, to build mipmux's native Swift helper. On macOS, use an Xcode or Command Line Tools installation that supplies Swift 6.2 or later; Homebrew provides CMake and pkg-config. Linux builds also need the Swift runtime libraries described in [Linux validation and runtime](docs/development.md#linux-validation-and-runtime).
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

2. Choose how discovery authenticates. Steps 2 and 3 below use a provider login stored by Pi. For an API key or a Claude Code login, use [API-key discovery](docs/configuration.md#discovery-with-an-api-key) or [Claude Code discovery](docs/configuration.md#claude-code-discovery) instead, then continue at step 4.

   For the Pi-login route, start the Pi CLI installed with mipmux, run `/login`, choose your provider and quit Pi. Skip sign-in if the credentials already exist in Pi's agent directory, normally `~/.pi/agent/auth.json` (`$PI_CODING_AGENT_DIR/auth.json` when set):

   ```sh
   node_modules/.bin/pi
   ```

3. Create the discovery configuration. The default directory is `~/.config/mipmux`, or `$XDG_CONFIG_HOME/mipmux` when set. Create that directory and a `models.json` file inside it containing:

   ```json
   { "providers": {} }
   ```

   This selects the model catalog bundled with mipmux's Pi SDK. In the same directory, create `config.json`. The following example uses an OpenAI Codex login; replace the provider, model and thinking level with values supported by your account, and replace `modelsPath` with the absolute path to the file you just created:

   ```json
   {
     "discovery": {
       "provider": "openai-codex",
       "model": "gpt-6.1-sol",
       "thinking": "medium",
       "modelsPath": "/absolute/path/to/mipmux/models.json"
     }
   }
   ```

   Run `node dist/cli/main.js config` to check the configuration, and `node dist/cli/main.js models` to list models available through the configured credentials. Neither command sends a prompt to a model. [Configuration](docs/configuration.md) describes every setting. For model-free packet assembly, use the [manual-packet tools](docs/mcp-tools.md#manual-packet-tools) with `"tools": "full"` instead of configuring discovery.

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

The default MCP interface has three tools: `context_builder` starts discovery, `context_job` follows the job or answers a clarification question, and `context_prepare` checks and prepares a saved packet with its final instructions. The server supplies workflow instructions when the client connects; the [agent workflow](docs/workflow.md) gives the full sequence and examples.

For a first run, give your agent a task such as "Build a context packet for reviewing the uncommitted changes in `/absolute/path/to/repo`, including the patch and relevant tests." The agent must create an output folder, such as that repository's `prompt-exports`, before starting the build. Each packet is saved in a distinct bundle directory there, alongside `manifest.json` and `handoff.md`, which record its contents and verification information.

Your agent should check the receipt's selected material and omissions against the task before preparing the packet, then hand the prepared `context.md` to the recipient as a file attachment or a path it can read.

In Pi, the [pi-mipmux extension](integrations/pi/README.md) adds a `/mipmux` command for choosing a saved workspace and setting build preferences, such as the budget or discovery model, that apply to the agent's calls. [omp-mipmux](integrations/omp/README.md) adds the same command to oh-my-pi.

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

- A new search checks the declared folders for changes before searching. Local macOS measurements on workspaces of roughly 1,000 files put content searches around 0.65–0.9 seconds, warm refreshes around 0.35–0.5 seconds, and refreshes after a restart around one second. Initial indexing with an empty cache took roughly 10–15 seconds. These are measurements of particular workspaces, not performance guarantees; file size, language and machine load matter.
- Code maps cover `.c`, `.cpp`, `.cs`, `.go`, `.java`, `.js`, `.php`, `.py`, `.rb`, `.rs`, `.swift`, `.ts` and `.tsx` files. Other text files can be included in full or as line ranges. Extracted declarations and name-based relationships can be incomplete or ambiguous, so relevant implementation code still matters when assessing behavior.
- Packet budgets use a byte-based estimate rather than the recipient model's tokenizer. Check the final packet against that model's context limit, allowing room for its other instructions and response.
- mipmux runs on macOS and Linux only.

## License

mipmux is licensed under the [Apache License 2.0](LICENSE). Its extractor derives from RepoPrompt CE revision `64b9352eec13e0252500d429f64ca9d1dd5e49fd`, also under Apache-2.0, and `docs/vendor-provenance.json` records where each retained file came from and how it was changed. [Third-party notices](THIRD_PARTY_NOTICES.md) identify the licenses of the code mipmux includes.
