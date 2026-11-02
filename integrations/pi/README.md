# pi-mipmux

pi-mipmux is a [Pi](https://pi.dev) extension for mipmux. Its `/mipmux` command opens a panel where you choose the folders that the agent's context packets come from, and set build preferences such as the budget and the discovery model. The extension applies these choices to the agent's `context_builder` and `context_prepare` calls before Pi sends them to mipmux.

## Install

pi-mipmux needs mipmux connected to Pi as an MCP server named `mipmux`, and the `mipmux` command on your PATH. With Pi's built-in MCP support:

```sh
pi mcp add mipmux -- mipmux mcp
pi install npm:pi-mipmux
```

## Use the panel

Run `/mipmux`. The panel lists every setting with the value a build would use now. Highlight a row and press a key:

| Key | Action |
|---|---|
| ↑ ↓ | Move between rows |
| Enter | Edit the highlighted value, or open its list |
| `p` | Pin or unpin the value; a pinned value replaces the value the agent sends |
| Delete or Backspace | Clear the value, or remove the highlighted item in a list |
| Ctrl+S | Save every change |
| Esc or Ctrl+C | Go back one screen; on the main screen, close the panel |

Nothing changes until you press Ctrl+S. The footer shows `(unsaved)` while changes are waiting, and closing the panel discards them. Saved changes apply from the agent's next mipmux call, with no restart or reconnect.

`/mipmux <name>` selects a saved workspace without opening the panel and completes saved names. In RPC mode, `/mipmux` sends the current settings to the client as a notification instead of opening the panel. Print mode (`pi -p`) and JSON mode have no UI, so `/mipmux` shows nothing there.

## Choose a workspace

Every build and prepare call names a workspace: the source folders mipmux indexes (its roots) and the output folder where mipmux saves packets. The panel saves workspaces under names so you can select one per session.

To create a workspace, press Enter on **Roots** and choose a folder. The workspace is named after that folder, or `name (1)` if the name is taken, and its output folder is `prompt-exports` inside it. Saving creates the output folder if it does not exist. Press Enter on **Roots** again to add or remove folders; a workspace keeps at least one. The other rows change the output folder and edit the ignore rules. **Rename workspace** changes the name; you never have to.

Enter on **Selected workspace** opens the list of saved workspaces. Select one for this session, delete one with Delete, start a new one from a folder, save the workspace the agent last declared in this session, or choose none.

While a workspace is selected, the agent receives its exact declaration in the system prompt, and the extension blocks a build or prepare call that names any other workspace, repeating the declaration in the error. With nothing selected, the agent chooses its own workspace and only your preferences apply. The extension never selects a workspace for you from Pi's current directory or from what the agent sends.

If the selected workspace is renamed or deleted, for example from another session, or `mipmux.json` cannot be read, the extension blocks build and prepare calls until you select a workspace again, and the footer adds `(missing)` or `(file error)` after the name.

## Type paths

Root, output folder and ignore rule rows open a path field with completion. Type a path as in a shell: `~` is your home folder, and a relative path starts at Pi's current directory, or at the root for an ignore rule. Root and output fields open with a suggested folder; Ctrl+U clears it.

Below the field, the first row is the path you typed, when it names something you can choose. The rows after it are the entries of the folder you are typing in that match the name typed so far, best match first. Matching ignores case, so `~/proj` finds `~/Projects`. Hidden entries appear once the name you type starts with a dot.

| Key | Action |
|---|---|
| Tab | Complete the typed name to the highlighted entry, as the disk spells it |
| Shift+Tab | Go up one folder |
| ↑ ↓ | Highlight another row |
| Enter | Choose the highlighted row |

While a name is partly typed, the best match is highlighted, so typing a few letters and pressing Enter chooses it.

## Leave paths out or bring them back

**Ignore rules** edits the `.mipmux_ignore` file at each root of the selected workspace. The file uses gitignore syntax, and mipmux reads it in every folder, so you can also edit it by hand or add one in a subfolder. A plain line leaves paths out. A line starting with `!` brings back a path that another ignore file hides, such as `.repo_ignore`, `.cursorignore`, mipmux's built-in patterns or Git's exclude files. Nothing brings back a path that `.gitignore` hides. As in Git, an ignore file in a deeper folder takes precedence over one in a folder above it, so to bring back a path that a subfolder's ignore file hides, add the `!` line to a `.mipmux_ignore` in that subfolder.

In the rule field, type a path inside the root, relative to it, or a pattern such as `*.log`, and put `!` in front to bring the path back. Tab completes the path after the `!`. A chosen path becomes a rule anchored to the root, such as `/node_modules/` or `!docs/investigations/`. Delete removes a highlighted rule. Ctrl+S writes the files you changed, keeping their comments, and refuses to overwrite a file that someone edited while the panel was open.

The rules belong to the folder, not to the saved workspace: every workspace and every client that uses the folder applies them, and RepoPrompt CE does not read them. Commit the file to share the rules, or add `.mipmux_ignore` to your global gitignore to keep it out of Git.

## Set preferences

| Setting | Applies to | Saved with |
|---|---|---|
| Budget, in mipmux's estimated units, such as `210000` or `210k` | builds; preparations only when pinned | the session |
| Enhancement mode: `augment`, `fullRewrite` or `preserve` | builds | the session |
| Clarification questions from discovery, with an optional timeout | builds in sessions with a UI | the session |
| Discovery model, from the models mipmux allows | builds | the session or the selected workspace |
| Thinking level for the discovery model | builds | the session or the selected workspace |

A value you set fills in a setting the agent leaves out. A pinned value replaces the agent's value too. From highest precedence to lowest, a build uses a pinned session value, a pinned workspace value, the agent's value, a session value, a workspace value, and finally the server default.

Session choices are recorded in the session itself: resuming or forking a session restores them, and a new session starts with nothing selected. They do not change mipmux's configuration file or other sessions. Changing a preference changes the request, so repeating an earlier build start under the same output name fails with `outputNameConflict`; the extension adds a note saying so, and a new output name solves it.

## Server defaults

The **Server defaults (all clients)** section edits mipmux's configuration file, whose path the panel names: the budget and enhancement mode of builds that name none, the discovery model and thinking level, and the allowed models. These apply to every client that uses mipmux, not only Pi. A running mipmux rereads them before each build, so a save takes effect at the next build without a reconnect. If `mipmux config` fails, the section is missing and the panel's header says why; if the file sets up no discovery, only the budget and enhancement mode rows appear.

The discovery model and **Allowed models** lists show the models mipmux has credentials for, from `mipmux models`; type to filter them. In **Allowed models**, Enter allows or disallows the highlighted model, and a model that is allowed but has no credentials is marked `no credentials`. Session and workspace model rows offer the discovery model and the allowed models, and mipmux refuses any other.

A save changes only the values you changed and keeps the file's other settings, their order and its indentation. It replaces the file only after `mipmux config` accepts the result, and refuses to overwrite a file that someone edited while the panel was open. Other settings in the file, such as the cache path or discovery credentials, apply when mipmux starts again; reconnect it from `/mcp` after editing them by hand.

## Footer

While the extension is loaded, Pi's footer shows `mipmux:` and the selected workspace, or `mipmux: no workspace`. The panel's last row, **Show in footer** under **Display**, turns this item on or off for all your sessions. The session where you save applies it at once; other open sessions apply it before their next prompt.

## Storage

Saved workspaces and the footer setting are stored in `mipmux.json` in Pi's agent directory (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`) and shared by all your sessions. The footer setting is its `showInFooter` field; a file without it shows the footer item. A session keeps only the name it selected, so an edit reaches every session on its next call. Saving applies only the workspaces you added, changed or deleted, so changes another session saved while the panel was open remain. Two saved workspaces with the same root folders and output folder, in any order and under any names, are duplicates: saving keeps the earlier one, with its name, discovery model and thinking level, and the panel says which it removed.

## Limits

- The extension sees calls that pass through Pi's tool pipeline, including calls from codemode scripts, under the tool names that Pi's built-in MCP support gives a server named `mipmux`: `mcp__mipmux__context_builder` and `mcp__mipmux__context_prepare`. Calls another extension makes outside Pi's tool pipeline bypass it.
- The panel reads and edits the configuration file that `mipmux config` reports when run from your PATH, and names it at the top. By default that is `~/.config/mipmux/config.json`, or `$XDG_CONFIG_HOME/mipmux/config.json`. If Pi starts mipmux with `--config` or a different `XDG_CONFIG_HOME`, the server uses another file, and the panel's server defaults and model lists do not describe that server.
- Without a UI, the clarification preference is not applied.

## Development

```sh
npm test
npm run typecheck
```

Both run from this directory and use the TypeScript, TypeBox and Pi packages installed in the mipmux checkout.

To run the extension from a checkout instead of npm, install it by path: `pi install /absolute/path/to/mipmux/integrations/pi`.
