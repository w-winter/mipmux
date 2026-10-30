# Agent workflow

This guide is for an agent that calls mipmux's MCP tools to build a context packet: one `context.md` file that contains the source files, slices (line ranges of files), code maps (syntax summaries of files) and Git patches a task needs, followed by the task itself. mipmux's discovery agent, a model that explores the code with mipmux's own tools, chooses that material. The packet goes to another model, usually one that plans, reviews or investigates. Field-level detail is in the [context protocol](context-protocol.md) and the [contracts](contracts.md).

In each run, the agent declares the workspace, starts a build, waits for it, checks its receipt, prepares the final packet and hands the packet to the recipient. The numbered sections below follow that order.

## Before the first run

Use one output folder for every run in a project: `prompt-exports` in the main repository's root. mipmux requires the folder to exist, so create it before declaring the workspace. mipmux publishes each packet as a bundle, a folder in the output folder that contains `context.md` with two records for the caller, `manifest.json` and `handoff.md`. It never indexes the output folder, so earlier packets never reappear as source. The output folder is part of a workspace's identity: a new folder for each run makes mipmux read every file again instead of reusing its index.

Keep `prompt-exports/` out of Git by listing it in `.gitignore`, in the repository's `info/exclude`, or in your global excludes file. Otherwise `git status` lists the packets as untracked files.

Choose a run ID from the date and a short task name, such as `20261029-login-timeout`, and start every `outputName` in the run with it, for example `20261029-login-timeout-review` and then `20261029-login-timeout-review-final`. A name cannot contain `/`, and mipmux refuses a name that already exists in the output folder.

## 1. Declare the workspace

A workspace is a set of named root folders plus the output folder; mipmux keeps an index of the workspace's files. Call `workspace_declare`:

```json
{
  "spec": {
    "roots": [{ "name": "app", "absolutePath": "/repos/app" }],
    "exclusions": [],
    "outputRoot": "/repos/app/prompt-exports"
  }
}
```

Declare every root the task needs and no unrelated ones; a task that spans several repositories declares one root per repository. Use `exclusions` only for further paths to keep out, as `{ "kind": "prefix", "root": "app", "path": "fixtures/large" }` or `{ "kind": "glob", "root": "app", "pattern": "..." }`. Build requests have no exclusion field of their own.

Keep the returned `id`. Declaring the same spec again reuses the open workspace and its index, and after a restart mipmux avoids rereading most files that have not changed. If a call fails with `unknownWorkspace`, the server has restarted: declare the same spec again. Leave the workspace open while you work on the project; `workspace_close` releases it.

## 2. Start a build

Call `context_builder` with `workspaceId`, a `requestId` and a `request`. The `requestId` is any string that is new to this session. Repeating an ID with the same request returns the existing job, so a retried call never starts a second build; the same ID with a different request fails.

| Request field | What to send |
|---|---|
| `purpose` | `"planning"`, `"review"` or `"investigation"`. |
| `copyPreset` | `"codeReview"` when the packet needs Git patches, which every review does; otherwise `"standard"`, which can leave selected patches out. |
| `task` | Everything discovery needs in order to select context: the user's request, the roots, each repository's Git comparison, the changed, untracked and deleted files, the paths of plans and reports, earlier findings, and who will read the packet. Name starting files and folders here; discovery looks beyond them. |
| `constraints` | `""`. mipmux copies this text into every packet prepared from the bundle, so the recipient's instructions belong in the final prompt (step 5). |
| `requiredSources` | Files that must appear in the packet, such as an approved plan: `{ "kind": "full", "source": { "root": "app", "path": "docs/plan.md" } }`. |
| `patches` | For a review, one `localPatch` per repository, described below. |
| `documents` | Text that is not a file under a root, such as a ticket: `{ "kind": "suppliedDocument", "id": "ticket", "role": "evidence", "origin": "issue tracker", "text": "..." }`. `role` is `"plan"`, `"report"` or `"evidence"`. |
| `initialSelection` | `{ "codemapMode": "automatic", "sources": [] }`, so that discovery chooses how to present each file. |
| `discoveryHints` | `[]` |
| `duplicateUserInstructionsAtTop` | `false` |
| `outputName` | A new name that starts with the run ID. |

Leave out `budgetUnits` and `enhancementMode` to use the server's defaults, and set `budgetUnits` only when the user gives a budget. mipmux measures packets in units of about 3.8 bytes each, which is an estimate and not any provider's token count. Leave out `clarification` as well: setting it to `{}` lets discovery ask the user questions through MCP form elicitation, which the client must support, or the build fails with `elicitationUnavailable`.

A `localPatch` captures a Git diff when the build runs:

```json
{
  "kind": "localPatch",
  "id": "app-changes",
  "root": "app",
  "comparison": { "kind": "worktree", "base": { "kind": "commit", "ref": "HEAD" }, "includeUntracked": true },
  "scope": { "kind": "all" }
}
```

`comparison` is `worktree` (the working tree against `base`, with or without untracked files), `staged` (the index against `base`) or `commits` (the commit `target` against `base`). A base is `{ "kind": "commit", "ref": "main" }` or `{ "kind": "empty" }`. `scope` is `{ "kind": "all" }`, or `{ "kind": "paths", "paths": [...] }` with paths relative to the root.

A complete review request:

```json
{
  "workspaceId": "<id from step 1>",
  "requestId": "20261029-login-timeout-review",
  "request": {
    "purpose": "review",
    "copyPreset": "codeReview",
    "task": "Collect context to review the uncommitted change in root app that fixes the login timeout. Changed: src/auth/session.ts, test/auth/session.test.ts. Approved plan: docs/plans/login-timeout.md. Select the changed code, the code that calls it and its tests. The packet goes to a code reviewer. Do not review or edit the code.",
    "constraints": "",
    "requiredSources": [{ "kind": "full", "source": { "root": "app", "path": "docs/plans/login-timeout.md" } }],
    "patches": [{
      "kind": "localPatch", "id": "app-changes", "root": "app",
      "comparison": { "kind": "worktree", "base": { "kind": "commit", "ref": "HEAD" }, "includeUntracked": true },
      "scope": { "kind": "all" }
    }],
    "documents": [],
    "initialSelection": { "codemapMode": "automatic", "sources": [] },
    "discoveryHints": [],
    "duplicateUserInstructionsAtTop": false,
    "outputName": "20261029-login-timeout-review"
  }
}
```

## 3. Wait for the build

`context_builder` returns a job snapshot that contains a `jobId`. Call `context_builder_wait` with `{ "jobId": "...", "durationMs": 50000 }`, choosing a `durationMs` below your client's tool-call timeout; Codex's default timeout is 60 seconds. While the job runs, the snapshot has `localSettled: false`: wait again on the same job. Discovery usually takes a few minutes.

When a wait ends, times out or is interrupted, the job keeps running. Never send a second `context_builder` request for the same work. `context_builder_result` returns the current snapshot, and `context_builder_cancel` stops the job.

A finished job's `state` is one of:

- `ready`: the packet is published. Go to step 4.
- `blocked`: the packet failed a check, such as its budget, and `validation` gives the reasons. Report this to the user.
- `failed` or `cancelled`: `code` gives the reason. Report it, and do not replace the build with context collected another way unless the user agrees.

## 4. Check the receipt

A ready snapshot's `bundle` describes the packet without its contents:

- `directory`: the bundle's folder in the output folder.
- `context`: the path of `context.md`.
- `accounting`: the packet's `units` and its `allowance`.
- `materials`: one entry per delivered file, slice, code map, document or patch.
- `omitted`: roots and files that could not be included, each with a code.
- `prompt`: the task as discovery clarified it.

Do not read `context.md` into your own context; it is written for the recipient and often runs to hundreds of kilobytes.

Compare the materials with the task. For a review, check that every changed file and every requested patch is present. For each `omitted` entry, decide whether the task can do without it. Add anything missing in step 5.

## 5. Prepare the final packet

Call `context_prepare` to give the saved packet its final task. It publishes a new bundle and makes no model call:

```json
{
  "workspaceId": "<id from step 1>",
  "bundle": "20261029-login-timeout-review",
  "prompt": "<the complete final task>",
  "outputName": "20261029-login-timeout-review-final"
}
```

`bundle` is the ready bundle's folder name. `prompt` becomes the packet's last section word for word, so write the complete task: the user's request, the roots and comparisons, the user's decisions, corrections from discovery, and the deliverable. Before publishing, mipmux checks every delivered material against the current files. A ready reply lists the materials it `added` and `removed` instead of the full list.

- A `sourceChanged` failure names a file that changed since the build. Send `refresh: true` to rebuild the packet from current files with the same selection. A packet that includes Git artifacts chosen by discovery (`gitPatch` or `gitMap` materials) cannot be refreshed and returns `refreshRequiresDiscovery`; start a new build instead.
- To add missing material, send `requiredSources`, `documents` or `patches`.
- To shrink the packet, `remove` optional files or Git artifacts, or `demote` optional files to code maps, naming each the way the receipt lists it: `root/path` for a file, or a Git artifact's alias. `budgetUnits` sets a budget the packet must fit; a packet over it returns `blocked` with `overBudget`.

## 6. Hand off the packet

Give the recipient the prepared bundle's `context.md`: its path if the recipient can read files, otherwise its contents. The file's last section, `user_instructions`, holds the task. Do not also send `manifest.json` or `handoff.md`; they are records for you.

Before sending, check that the packet fits the recipient's context window with room for its own instructions, tools and answer. Units are only an estimate: in one measurement, a packet of 181,000 units came to 303,000 Claude tokens. If the packet does not fit, ask the user whether to shrink it (step 5) or to split the task.

## Later runs and cleanup

To give a ready bundle a different task, prepare it again with a new prompt; while its files are unchanged, no discovery is needed. Start a new build when the scope, roots or comparisons change.

Builds that capture Git evidence store snapshots in `<output folder>/_git_data`, which every run in the project shares. mipmux deletes snapshots older than seven days and all but the newest 25, so preparing an older review bundle can fail; start a new build when it does. `context_builder_dispose` deletes one job's snapshots when you no longer need its bundles.

To select context yourself instead of running discovery, use `draft_create`, `manage_selection`, `draft_validate` and `draft_finalize`. The server offers them when its `tools` setting is `"full"`; they are described in the README's [manual context packets](../README.md#manual-context-packets) section.

## Common mistakes

- Creating a new output folder for each run, which makes every run reread the whole workspace.
- Declaring roots that the task does not need.
- Putting the task in `constraints` instead of `task` and the final prompt.
- Starting a new build because a wait returned before the job finished.
- Reading `context.md` into your own context.
- Sending a review packet without checking that it contains every changed file and the patch.
