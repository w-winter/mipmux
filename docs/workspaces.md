# Workspaces and ignore rules

A workspace is the set of root folders and the output folder that a call declares. This page explains which files in those folders mipmux indexes and offers to discovery, and which it never reads. mipmux follows the ignore rules of RepoPrompt CE (RPCE), with its own `.mipmux_ignore` files and Git's exclude files added.

## Ignore files

Workspace visibility follows RPCE's ignore rules. Git repositories apply a mandatory `.gitignore` filter, including ancestor controls when a loaded root is below the repository root. Global patterns, `.repo_ignore`, `.cursorignore` and mipmux's own `.mipmux_ignore` supply additional ordered rules. Optional `ignoreSettings` in the host configuration or runtime options sets `global` pattern text and the booleans `respectRepoIgnore`, `respectCursorignore` and `enableHierarchicalIgnores`. Omission uses RPCE's global defaults, including dependency and cache directories, with all three switches enabled.

## `.mipmux_ignore`

`.mipmux_ignore` uses gitignore syntax and works in any folder, as `.repo_ignore` does. It changes what mipmux indexes without changing what RepoPrompt CE sees: a plain line leaves paths out, and a `!` line brings back a path that `.repo_ignore`, `.cursorignore`, the global patterns or Git's exclude files hide, even inside a folder they hide. Within one folder its rules take precedence over `.repo_ignore` and `.cursorignore`; as in Git, a file in a deeper folder takes precedence over one in a folder above it. Nothing brings back a path that `.gitignore` ignores. Edits apply at the next call, without restarting mipmux.

## Git's exclude files

With Git configured, a repository's own exclude files also apply: `info/exclude` and the excludes file your Git configuration names, `core.excludesFile` or Git's default `~/.config/git/ignore`. They rank below `.gitignore`, `.repo_ignore`, `.cursorignore` and `.mipmux_ignore`, so a `!` line in any of those re-includes a path they exclude, even inside a folder they exclude. They never exclude a file Git tracks, or a folder containing one, so a tracked `AGENTS.md` that matches them stays in the workspace. Editing either file changes the workspace's ignore policy, as editing a `.gitignore` does. The `git` tool's status and untracked diff listings apply the same excludes file. mipmux reads the `core.excludesFile` setting once per repository while it runs; restart mipmux after changing it. Library hosts pass the user's `home` and `xdgConfigHome` as `git.userConfiguration`; without it only `info/exclude` applies, and without Git neither file does.

## Exclusions and protected paths

Explicit exclusions govern every root, including overlapping roots. Git administration paths, `.env` files, configured credential paths (including ones that do not exist yet), the cache, and the admitted output directory are excluded. Absolute denies also apply through declared root aliases, including aliases of containing roots. Descendant source symlinks are skipped. This protects excluded material; it cannot identify arbitrary secrets renamed into permitted files.
