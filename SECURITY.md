# Security

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's Security tab and choose "Report a vulnerability". Please do not open a public issue for it. While mipmux is alpha software, fixes go to the latest commit on `main`.

## What mipmux reads, writes, runs and contacts

mipmux reads whole source trees and, when discovery is configured, runs a model agent: one built on the SDK of [Pi](https://pi.dev), an open-source coding agent, which uses model credentials mipmux holds, or Claude Code, driven through Anthropic's Claude Agent SDK, which uses its own login. This section describes exactly what mipmux touches.

### Reads

- Files under the folders a caller declares, except files hidden by ignore rules: `.gitignore`, `.repo_ignore`, `.cursorignore`, `.mipmux_ignore`, Git's `info/exclude`, the excludes file your Git configuration names, and mipmux's global patterns. A caller can still read an ignored file inside a declared folder by naming its exact path.
- Never as source: Git's administration folders, `.env` files, paths listed in `credentialPaths`, mipmux's own configuration, model and credential files, its cache, and the output folder.
- Its configuration file (`~/.config/mipmux/config.json` unless `--config` names another), the discovery prompt template, the discovery models file, and Pi's `auth.json` for provider credentials. mipmux rejects any value in the models or credential file that starts with `!`, which Pi would otherwise run as a shell command to obtain a key.
- Your global Git configuration, only to find the `core.excludesFile` setting.
- No Claude credentials. In Claude Code discovery, Claude Code reads its own login (from the macOS Keychain, or `~/.claude/.credentials.json` elsewhere), its `~/.claude.json` and any managed settings, which mipmux cannot turn off. mipmux keeps Claude Code's configuration directory, `~/.claude` or `CLAUDE_CONFIG_DIR`, and `~/.claude.json` out of source collection.

### Writes

- The cache folder (`~/Library/Caches/mipmux` on macOS; `$XDG_CACHE_HOME/mipmux` or `~/.cache/mipmux` elsewhere): index records, code maps, saved file fingerprints, and temporary Git work under `work/`.
- The output folder a caller declares: one folder per packet (`context.md`, `manifest.json` and `handoff.md`), interim exports a caller requests, and Git snapshots under `_git_data`.
- Pi's `auth.json`, when discovery refreshes an expired provider login, as Pi itself does.
- In Claude Code discovery, Claude Code writes `~/.claude.json` and a log of MCP tool names and timings, without arguments or results, in its cache folder (`~/Library/Caches/claude-cli-nodejs` on macOS). It saves no conversation. Its working directory is `claude-code` in mipmux's cache folder.

### Runs

- The native helper, `MipmuxBridge`, with only the environment listed in `nativeEnvironment`. It contains no networking code.
- Git (`/usr/bin/git` unless configured otherwise), with the system configuration, hooks, the file-system monitor, terminal prompts, network transports (`protocol.allow=never`) and on-demand object fetching (`GIT_NO_LAZY_FETCH`) turned off. Your global Git configuration is read only for the excludes-file lookup. Git can still run clean and process filter programs that a repository's own Git configuration defines when it computes status or a diff, so use mipmux only on repositories whose Git configuration you trust.
- The discovery worker, a Node process that runs Pi's agent SDK, started for each discovery job. Its environment contains only the variables in `discovery.environment` and `PI_OFFLINE=1`, plus, when `discovery.mcp` is set, `HOME`, `TMPDIR` and `PI_CODING_AGENT_DIR` pointing at the directory that `discovery.mcp` names.

- Claude Code, through the Claude Agent SDK, for each Claude Code discovery job and each `mipmux models` listing, when `discovery.claudeCode` is configured. Its environment contains `HOME`, `PATH` and `USER` from mipmux's environment, the variables in `discovery.claudeCode.environment`, and four settings: `ENABLE_CLAUDEAI_MCP_SERVERS=0`, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `ENABLE_TOOL_SEARCH=false`.

mipmux never runs a shell command that a model chooses.

### The discovery agent

- Pi's built-in tools, which read files, run shell commands and edit files, are turned off. The agent can call mipmux's exploration and selection tools, which are confined to the declared folders and the job's working selection; the `codemode` tool, which runs each JavaScript script in a separate QuickJS WebAssembly instance and lets it call only those same tools; and any tools you expose from HTTP MCP servers configured under `discovery.mcp`. The worker compares its tool list with this set at startup and stops with `unexpectedToolAccess` if they differ.
- The agent loads no skills, prompt templates or `AGENTS.md` files, and keeps its session in memory.
- Claude Code runs with no built-in tools, settings, project instructions, skills, plugins, claude.ai connectors or MCP servers of its own. Before the first model request, mipmux checks that it offers exactly mipmux's discovery tools and the allowlisted external tools.
- The task, and everything the agent reads with its tools, goes to the configured model provider as part of the conversation.

### Network

- mipmux's own code makes no network connections, except that in Claude Code discovery it connects to the HTTP MCP servers configured under `discovery.mcp`. MCP clients talk to it over stdin and stdout.
- During a discovery job, the worker connects to the configured model provider (for `openai-codex`, `chatgpt.com`), to the provider's sign-in service when it refreshes an expired login (for `openai-codex`, `auth.openai.com`), and to HTTP MCP servers configured under `discovery.mcp`. `PI_OFFLINE=1` and mipmux's model settings keep Pi from downloading its model catalog.
- In Claude Code discovery, Claude Code connects to Anthropic's API, or to the `ANTHROPIC_BASE_URL` its environment names, and to Anthropic's sign-in service when it refreshes a login. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off its telemetry and update checks.
- mipmux sends no telemetry or usage reports.

A complete discovery job was observed on macOS on 2026-10-30, at commit `fe4560a` with the `openai-codex` provider (20 model turns, 23 tool calls). A preloaded hook logged every socket connection, DNS lookup and process start in mipmux's Node processes, and `lsof` sampled the network sockets of the whole process tree five times a second. The only network connection was one HTTPS connection from the discovery worker to `chatgpt.com`.

### Installing

- mipmux has no install scripts of its own. Two of its dependencies declare them: `@google/genai` and `protobufjs`. The repository's `.npmrc` turns install scripts off for `npm ci` in a clone, and mipmux does not need them.
- Release archives include production npm dependencies installed from the lockfile with scripts disabled. Extracting an archive requires no package installation. The [release guide](docs/releases.md) describes how to verify its GitHub build and release attestations before use.
- The Claude Agent SDK, needed only for Claude Code discovery, is not a dependency of mipmux; you install it yourself. It is licensed under Anthropic's own terms, and it installs Claude Code's executable for your platform through an optional dependency.
- The source build pins every download: npm packages by the integrity hashes in `package-lock.json`, SwiftPM packages by commit in `native/Package.resolved`, and PCRE2 by the SHA-256 in `native/pcre2-recipe.json`.
