# Configuration

This page lists every setting in mipmux's configuration file and explains how to set up discovery: with a provider login stored by Pi, with a provider's API key, or with Claude Code; with MCP servers that discovery may use; and with your own copy of the discovery prompt. RPCE stands for RepoPrompt CE, whose Context Builder mipmux ports.

## The configuration file

mipmux reads `$XDG_CONFIG_HOME/mipmux/config.json`, or `~/.config/mipmux/config.json` when that variable is unset. Every command, including `mcp`, accepts `--config /absolute/file.json` to read another file. Paths in the file must be absolute.

Every configuration field is optional. Enabling `discovery` requires `provider`, `model` and `thinking`. When the configured model or an allowed one runs through Pi, which is every provider but `claude-code`, discovery also requires `modelsPath`, the path of the model file described under [Discovery with a Pi login](#discovery-with-a-pi-login); when one is a `claude-code/` model, it requires `discovery.claudeCode`. A file sets only what differs from the defaults.

A running MCP server rereads the file before each `context_builder` and `draft_create` call and applies `contextBudgetUnits`, `defaultEnhancementMode`, and `discovery.provider`, `discovery.model`, `discovery.thinking` and `discovery.allowedModels` to builds started from then on; jobs already started keep their settings. A file that cannot be read or is not valid configuration fails that call. Every other field, and turning discovery on or off, takes effect when the server starts again.

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
    "allowedModels": ["anthropic/claude-sonnet-4-6"],
    "policy": { "compaction": { "reserveTokens": 9000 } }
  }
}
```

## Settings

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
| `git` | `{ "executable": "/usr/bin/git" }`, with `userConfiguration` taken from `HOME` and `XDG_CONFIG_HOME` so that Git finds your excludes file. Set `null` to work without Git |
| `defaultMaxOutputBytes` | `48000`, which keeps a default exploration reply below Pi's 50 KiB tool-output limit |
| `tools` | `"core"`: the MCP server offers `context_builder`, `context_job` and `context_prepare`, which build and prepare packets through Context Builder. `"full"` adds the workspace, exploration and manual-packet tools. `mcp --tools <set>` overrides this for one server |
| `discovery` | `null`, for model-free use |
| `discovery.allowedModels` | none. Lists `provider/model` references, in Pi's notation, that a build request may select instead of the configured model, which is always allowed |
| `discovery.authPath` | `auth.json` in `$PI_CODING_AGENT_DIR`, or in `~/.pi/agent` when that variable is unset |
| `discovery.claudeCode` | none. Enables `claude-code/` models; see [Claude Code discovery](#claude-code-discovery) |
| `discovery.claudeCode.executable` | the Claude Code that the Claude Agent SDK installs with it |
| `discovery.claudeCode.environment` | `HOME`, `PATH` and `USER` from mipmux's environment. Listed entries replace or add to them in Claude Code's environment |
| `discovery.promptTemplatePath` | the shipped `dist/prompts/discovery.md` |
| `discovery.environment` | none. The environment of Pi's discovery worker |
| `discovery.mcp` | `null` |
| `discovery.codemode` | `true`, which also offers the agent Pi's `codemode` tool; its scripts call the same discovery tools |
| `discovery.policy` | Pi's defaults, merged field by field with the file's overrides: retries `enabled`, `maxRetries: 3`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60000`; provider requests `timeoutMs` equal to `httpIdleTimeoutMs`, `maxRetries: 0`, `maxRetryDelayMs: 60000`; compaction `enabled`, `reserveTokens: 16384`, `keepRecentTokens: 20000`; `transport: "auto"`, `httpIdleTimeoutMs: 300000`, `websocketConnectTimeoutMs: 15000` |

Discovery never warms prompt caches, because warming is billed; `policy.cacheWarming` accepts only `"off"`. `copyContext` accepts RPCE's copy-state record, with `current`, `customizations`, `codeMapsGloballyDisabled`, `activeGitRoot` and `presets`, when you need custom presets or customizations. Library hosts pass the resolved form, with every field explicit, to `createMcpServer` (see [TypeScript library](library.md)).

## Discovery with a Pi login

Discovery through Pi takes credentials from Pi's `auth.json` (`discovery.authPath`), where Pi's `/login` stores them, as the [quickstart](../README.md#quickstart) shows. It takes models from the providers built into mipmux's Pi SDK, adjusted by the model file (`discovery.modelsPath`). Pi's discovery worker reads the authorized authentication and model files; these paths and the host's configuration file are excluded from source discovery. The model file accepts a `providers` object with optional `baseUrl` and per-model `modelOverrides` containing `contextWindow` and `maxTokens`. Use `{ "providers": {} }` to select the bundled catalog explicitly. Other fields in model configuration and command-valued credentials are rejected. Supply the exact physical provider/model and supported thinking level; configuration errors require correction before another request.

## Discovery with an API key

Discovery can use a provider's API key without Pi or a Pi login. Put the key in `discovery.environment` under the variable Pi reads for that provider. mipmux reads `discovery.authPath` even when the key comes from the environment, so point it at a file containing `{}`:

```json
{
  "discovery": {
    "provider": "openrouter",
    "model": "google/gemini-3.8-flash",
    "thinking": "low",
    "modelsPath": "/home/you/.config/mipmux/models.json",
    "authPath": "/home/you/.config/mipmux/auth.json",
    "environment": { "OPENROUTER_API_KEY": "sk-or-..." }
  }
}
```

Pi reads `ANTHROPIC_API_KEY` for `anthropic`, `OPENAI_API_KEY` for `openai`, `GEMINI_API_KEY` for `google`, `OPENROUTER_API_KEY` for `openrouter`, `MISTRAL_API_KEY` for `mistral`, `XAI_API_KEY` for `xai`, `GROQ_API_KEY` for `groq` and `DEEPSEEK_API_KEY` for `deepseek`. `mipmux models` lists the models the key reaches. The key is then stored in the configuration file, so make that file readable only by you, for example with `chmod 600`.

## Claude Code discovery

Discovery can run Claude models through Claude Code, signed in with your own Claude account or with an API key. mipmux drives Claude Code through Anthropic's Claude Agent SDK, an optional add-on that Anthropic licenses under its own terms. Install the version mipmux requires next to mipmux, globally beside a global mipmux or into the same project, and sign in to Claude Code once:

```sh
npm install -g @anthropic-ai/claude-agent-sdk@0.3.310
claude
```

The SDK installs its own copy of Claude Code, about 230 MB. To use a Claude Code you already have, set `discovery.claudeCode.executable` to its absolute path. Then configure discovery with a `claude-code/` model. A configuration that uses only Claude Code needs no `modelsPath`:

```json
{
  "discovery": {
    "provider": "claude-code",
    "model": "claude-sonnet-5-5",
    "thinking": "low",
    "allowedModels": ["claude-code/claude-opus-5-5"],
    "claudeCode": {}
  }
}
```

`mipmux models` lists the Claude Code models your account offers. A model name Claude Code does not recognize fails the build when Anthropic's API refuses it, and the receipt records the error. The thinking levels `low`, `medium`, `high`, `xhigh` and `max` set Claude Code's effort level and must be among the levels the model supports; `off` turns thinking off; `minimal` fails with `unsupportedThinkingLevel`. These checks run before any model request.

Claude Code receives the rendered discovery template as its system prompt. Claude Code adds a billing header and a line identifying the Agent SDK before it, and short reminders of the date and environment to the first message, about 330 tokens in all. It offers the model only mipmux's discovery tools, named `mcp__mipmux__<tool>` in requests and in the template, and the allowlisted tools of the servers configured under `discovery.mcp`. Before the first model request, mipmux checks that Claude Code offers exactly those tools. Claude Code loads no settings, project instructions, skills, plugins or other MCP servers, does not save the conversation, and runs in `claude-code` under `cachePath`. mipmux sets `ENABLE_CLAUDEAI_MCP_SERVERS=0`, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `ENABLE_TOOL_SEARCH=false` in Claude Code's environment. A question from `ask_user` keeps its tool call open for as long as the question waits, and discovery continues in the same conversation once it is answered.

On macOS, Claude Code needs `USER` to find a Claude login in the Keychain; without it, Claude Code reports that the OAuth session expired. To use an API key instead, set `ANTHROPIC_API_KEY` in `discovery.claudeCode.environment`; mipmux does not pass on the variables of its own environment. mipmux never reads Claude credentials. It excludes Claude Code's configuration directory, `~/.claude` or `CLAUDE_CONFIG_DIR`, and `~/.claude.json` from context collection. A build's receipt records Claude Code's version, the model, where its credential came from, each response's usage and the cost Claude Code reports at list prices.

## MCP servers for discovery

Set `discovery.mcp` to `{ "agentDirectory": "/private/mipmux/discovery-mcp" }` to let discovery use selected tools from HTTP MCP servers. Use a dedicated directory with permissions `0700` containing `mcp.json`; set `mcp` to `null` to use only mipmux tools. Replace the URL and tool name in this example with your server's values:

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
cd /private/mipmux/discovery-mcp
PI_CODING_AGENT_DIR="$PWD" /opt/mipmux/node_modules/.bin/pi mcp login tickets
PI_CODING_AGENT_DIR="$PWD" /opt/mipmux/node_modules/.bin/pi mcp list
```

If discovery reports `mcpToolsUnavailable`, use `mcp list` in the private directory to diagnose connection or sign-in problems. See the [discovery contract](contracts.md#discovery-and-client-ownership) for configuration options and lifecycle details.

Claude Code discovery connects to these servers itself and supports header authentication only; a server configured for OAuth fails its builds with `mcpOAuthUnsupported`. Many servers accept an API key in a header instead. Linear's, for example, accepts `"headers": { "Authorization": "Bearer <Linear API key>" }`, and a key limited to read access, or the `https://mcp.linear.app/mcp/readonly` endpoint, keeps discovery from changing anything.

Discovery keeps text it fetches from these servers in the packet with `draft_update`'s `addDocument` mutation, as a supplied document with an ID, a role and the origin it asserts; such documents appear in `context.md` and count toward the budget. A build's receipt lists the authorized servers and tools, a digest of their configuration, the tool names discovery observed and whether shutdown was sent. Closing the discovery worker releases its local connections; it does not cancel work a server has already started.

## The discovery prompt

Set `discovery.promptTemplatePath` to an absolute path to your editable discovery template. Install the shipped `dist/prompts/discovery.md` into an existing operator-owned directory using exclusive creation:

```sh
node --input-type=module <<'JS'
import { constants, copyFileSync } from 'node:fs';
copyFileSync('/opt/mipmux/dist/prompts/discovery.md',
  '/private/mipmux/discovery.md', constants.COPYFILE_EXCL);
JS
```

Edit that copy's named policy sections using the [template format](discovery-prompt-bindings.md#template-format). Swift composes Rewrite, Augment or Preserve, review and clarification guidance from the template and captured facts. Both system policy and startup metadata use the budget after one 1500-unit reserve; complete-packet measurement uses the configured assembly allowance. Startup data contains the file map, current prompt and discovery instructions. A runtime observation supplies routing, revision, fixed constraints and evidence accounting.

Each job admits one regular UTF-8 file and retains that snapshot through all its turns. Later jobs observe edits to the same path. Use atomic file replacement when updating policy during active work. Missing files, invalid encoding or template syntax, and nonregular paths produce admission errors before Pi discovery starts. Package builds update the shipped default; your configured copy remains operator-owned.

The terminal receipt records `templateVersion`, the template path and raw-byte `template.identity`, and the rendered system policy's `policyIdentity`. Each identity contains SHA-256 and UTF-8 byte count. SDK working-directory framing, tools and startup messages are outside the policy digest.
