# pi-mipmux

pi-mipmux is a [Pi](https://pi.dev) extension for using mipmux through [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). It adds a `/mipmux` command that lets you choose which folders the agent's context packets come from and set build preferences, such as the budget and the discovery model. The extension applies your choices to the agent's `context_builder` and `context_prepare` calls before the adapter sends them to mipmux.

## Install

pi-mipmux needs mipmux configured as an MCP server named `mipmux` in pi-mcp-adapter, and the `mipmux` command on your PATH. Install the extension from a mipmux checkout:

```sh
pi install /absolute/path/to/mipmux/integrations/pi
```

## Choose a workspace

Every build and prepare call names a workspace: the source folders (roots), the output folder where mipmux saves packets, and any excluded paths. Run `/mipmux` to open the panel, then choose the workspace row:

- **Create a saved workspace** proposes the Git repository that contains Pi's current directory, or the directory itself outside a repository, with a `prompt-exports` output folder inside it. Add or remove roots, change the output folder and add exclusions, then name the workspace. The output folder is created when you confirm.
- **Save the workspace the agent last used** turns the agent's most recent declaration in this session into a saved workspace.
- **Select a saved workspace** chooses one for this session. `/mipmux <name>` does the same without the panel, and completes saved names.
- **Clear the selection** returns to letting the agent choose.

While a workspace is selected, the agent receives its exact declaration in the system prompt, and a build or prepare call that names any other workspace is blocked with a message repeating the declaration. Nothing is selected until you select it: the extension never chooses a workspace from Pi's current directory or from what the agent sends. The status line shows `mipmux: <name>`, or `mipmux: no workspace`.

Saved workspaces are stored in `mipmux.json` in Pi's agent directory (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`) and shared by all your sessions; a session keeps only the name it selected, so an edit reaches every session on its next call. Two saved workspaces with the same root folders, output folder and exclusions, in any order and under any names, are duplicates: the extension keeps the earlier one, with its name and model, and tells you what it removed.

## Set preferences

The panel lists five settings with the value a build would use and where it comes from:

| Setting | Applies to | Can also be saved with the workspace |
|---|---|---|
| Budget, in mipmux's estimated units | builds; preparations only when pinned | no |
| Enhancement mode: `fullRewrite`, `augment` or `preserve` | builds | no |
| Clarification questions from discovery, with an optional timeout | builds in sessions with a UI | no |
| Discovery model, from the models the server allows | builds | yes |
| Thinking level for the discovery model | builds | yes |

A value you set for the session or the selected saved workspace fills in a setting the agent leaves out. Pin a value to make it replace the agent's value too. From highest precedence to lowest, a build uses: a pinned session value, a pinned saved-workspace value, the agent's value, a session value, a saved-workspace value, and finally the server's default from mipmux's configuration file.

The panel shows the server defaults and the allowed models by running `mipmux config`. mipmux reads its configuration when it starts, so after editing the file run `/mcp-adapter reconnect mipmux`. The discovery models come from `discovery.allowedModels` in that file, and mipmux refuses any other model.

Session choices are recorded in the session itself: resuming or forking a session restores them, and a new session starts with nothing selected. They never change mipmux's configuration file or other sessions.

Changing a preference changes the request, so repeating an earlier build start under the same output name then fails with `outputNameConflict`; the extension adds a note saying so. Use a new output name.

## Limits

- The extension sees calls that pass through Pi's tool pipeline: the adapter's `mcp` tool, the `mcp__mipmux` tool and the per-tool registrations, including calls from codemode scripts. Calls another extension makes through the adapter's `pi-mcp-adapter:runtime-tool-call:v1` event, and calls from MCP App views, bypass it.
- Per-tool names that the adapter gives a hash suffix after a name collision are not recognized; calls through `mcp` and `mcp__mipmux` still are.
- Without a UI, as in `pi -p`, the clarification preference is not applied, and `/mipmux` prints the effective state instead of opening the panel.

## Development

```sh
npm test
npm run typecheck
```

Both run from this directory and use the TypeScript, TypeBox and Pi packages installed in the mipmux checkout.
