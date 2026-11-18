# Changelog

## [Unreleased]

## [0.1.1] - 2026-11-04

### Changed
- The README shows a recording of the `/mipmux` panel.
- The README's install section points to the mipmux quickstart for installing mipmux, which is published on npm.

## [0.1.0] - 2026-11-03

### Highlights
- Choose the folders that the agent's context packets come from, and save them as named workspaces, from one `/mipmux` panel.
- Set the budget, discovery model and other build preferences for a session or a workspace, and pin them over the values the agent sends.
- Wait for a long build with `mipmux_wait`, which ends as soon as you send a steering message.

### Added
- The `/mipmux` command opens a panel that lists every setting with the value a build would use now. Changes apply from the agent's next mipmux call after you press Ctrl+S. `/mipmux <name>` selects a saved workspace without opening the panel.
- Saved workspaces, stored in `mipmux.json` in Pi's agent directory and shared by all your sessions. While a workspace is selected, the agent receives its declaration in the system prompt, and the extension blocks build and prepare calls that name another workspace.
- Path fields with completion for roots, output folders and ignore rules.
- **Ignore rules** edits the `.mipmux_ignore` file at each root of the selected workspace.
- Preferences for the budget, enhancement mode, clarification questions, discovery model and thinking level, saved with the session or the selected workspace. A preference fills in a value the agent leaves out, and a pinned preference replaces the agent's value.
- **Server defaults (all clients)** edits mipmux's configuration file: the default budget and enhancement mode, the discovery model and thinking level, and the allowed models.
- A footer item that shows the selected workspace. **Show in footer** turns it on or off for all your sessions.
- The `mipmux_wait` tool waits for a build job as `context_job` does with `op: "wait"`. When you send a steering message, the wait ends at once and the job keeps running. The extension blocks `context_job` waits and tells the agent to use `mipmux_wait` instead.
