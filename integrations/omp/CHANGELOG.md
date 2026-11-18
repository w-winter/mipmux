# Changelog

## [Unreleased]

## [0.1.1] - 2026-11-04

### Changed
- The README shows a recording of the `/mipmux` panel in Pi. omp-mipmux opens the same panel in omp.
- The README's install section points to the mipmux quickstart for installing mipmux, which is published on npm.

## [0.1.0] - 2026-11-03

### Highlights
- The pi-mipmux `/mipmux` panel for oh-my-pi: choose the folders that the agent's context packets come from, save them as named workspaces, and set build preferences.

### Added
- The `/mipmux` panel, saved workspaces, ignore rules, preferences, server defaults and footer item work as in pi-mipmux 0.1.0, with omp in place of Pi.
- Saved workspaces and the footer setting are stored in `mipmux.json` in omp's agent directory, which is `~/.omp/agent`, the active profile's agent directory, or `$PI_CODING_AGENT_DIR`.
- The extension applies to calls to omp's tool names `mcp__mipmux_context_builder` and `mcp__mipmux_context_prepare`, and to the two-underscore forms of those names, which omp also accepts.
- The selected workspace's declaration reaches the agent as a `<mipmux_workspace>` block in the system prompt.
