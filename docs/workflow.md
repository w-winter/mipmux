# Agent workflow

This guide is for an agent that calls mipmux's MCP tools to build a context packet: one `context.md` file that contains the source files, slices (line ranges of files), code maps (syntax summaries of files) and Git patches a task needs, followed by the task itself. mipmux's discovery agent, a model that explores the code with mipmux's own tools, chooses that material. The packet goes to another model, usually one that plans, reviews or investigates. Field-level detail is in the [context protocol](context-protocol.md) and the [contracts](contracts.md).

In each run, the agent starts a build, waits for it, checks its receipt, prepares the final packet and hands the packet to the recipient. The numbered sections below follow that order.

## Before the first run

Use one output folder for every run in a project: `prompt-exports` in the main repository's root. mipmux requires the folder to exist, so create it before the first build. mipmux publishes each packet as a bundle, a folder in the output folder that contains `context.md` with two records for the caller, `manifest.json` and `handoff.md`. It never indexes the output folder, so earlier packets never reappear as source. The output folder is part of a workspace's identity: a new folder for each run makes mipmux read every file again instead of reusing its index.

Keep `prompt-exports/` out of Git by listing it in `.gitignore`, in the repository's `info/exclude`, or in your global excludes file. Otherwise `git status` lists the packets as untracked files.

Choose a run ID from the date and a short task name, such as `20261029-login-timeout`, and start every `outputName` in the run with it, for example `20261029-login-timeout-review` and then `20261029-login-timeout-review-final`. A name cannot contain `/`, and mipmux refuses a name that already exists in the output folder.

## 1. Describe the workspace

A workspace is a set of named root folders plus the output folder; mipmux keeps an index of the workspace's files. Every `context_builder` and `context_prepare` call names its workspace:

```json
{
  "roots": [{ "name": "app", "absolutePath": "/repos/app" }],
  "outputRoot": "/repos/app/prompt-exports"
}
```

Name every root the task needs and no unrelated ones; a task that spans several repositories names one root per repository. Add `exclusions` only for further paths to keep out, as `{ "kind": "prefix", "root": "app", "path": "fixtures/large" }` or `{ "kind": "glob", "root": "app", "pattern": "..." }`.

Send the same workspace with every call in the project. The server indexes a workspace the first time a call names it and keeps that index for later calls on the same connection; after a restart, mipmux avoids rereading most files that have not changed.

## 2. Start a build

Call `context_builder` with these fields:

| Field | What to send |
|---|---|
| `workspace` | The workspace from step 1. |
| `purpose` | `"planning"`, `"review"` or `"investigation"`. |
| `task` | Everything discovery needs in order to select context: the user's request, the roots, each repository's Git comparison, the changed, untracked and deleted files, the paths of plans and reports, earlier findings, and who will read the packet. Name starting files and folders here; discovery looks beyond them. |
| `outputName` | A new name that starts with the run ID. |
| `required` | Optional. Files that must appear in the packet, such as an approved plan: `{ "root": "app", "path": "docs/plan.md" }`. Add `"lines": [{ "start": 10, "end": 40 }]` to include only those lines. |
| `patches` | Optional. For a review, one patch per repository, described below. |
| `documents` | Optional. Text that is not a file under a root, such as a ticket: `{ "id": "ticket", "role": "evidence", "origin": "issue tracker", "text": "..." }`. `role` is `"plan"`, `"report"` or `"evidence"`. |

`copyPreset` chooses the packet's format. It defaults to `"codeReview"`, which includes Git patches, for a review or a build with patches, and otherwise to `"standard"`, which can leave selected patches out; set it only to override that choice. Leave out `budgetUnits` and `enhancementMode` to use the server's defaults, and set `budgetUnits` only when the user gives a budget. mipmux measures packets in units of about 3.8 bytes each, which is an estimate and not any provider's token count. Leave out `clarification` as well: setting it to `{}` lets discovery ask the user questions through MCP form elicitation, which the client must support, or the build fails with `elicitationUnavailable`.

A patch captures a Git diff when the build runs:

```json
{ "id": "app-changes", "root": "app", "comparison": { "kind": "worktree", "base": "HEAD", "includeUntracked": true } }
```

`comparison` is `worktree` (the working tree against `base`, with or without untracked files), `staged` (the index against `base`) or `commits` (the commit `target` against `base`). `base` and `target` are Git refs, such as `"main"` or a commit hash. Add `"paths": [...]`, relative to the root, to limit the patch to those paths.

A complete review build:

```json
{
  "workspace": { "roots": [{ "name": "app", "absolutePath": "/repos/app" }], "outputRoot": "/repos/app/prompt-exports" },
  "purpose": "review",
  "task": "Collect context to review the uncommitted change in root app that fixes the login timeout. Changed: src/auth/session.ts, test/auth/session.test.ts. Approved plan: docs/plans/login-timeout.md. Select the changed code, the code that calls it and its tests. The packet goes to a code reviewer. Do not review or edit the code.",
  "outputName": "20261029-login-timeout-review",
  "required": [{ "root": "app", "path": "docs/plans/login-timeout.md" }],
  "patches": [{ "id": "app-changes", "root": "app", "comparison": { "kind": "worktree", "base": "HEAD", "includeUntracked": true } }]
}
```

The output folder and `outputName` identify the build. If a call fails or times out, send the same call again: it returns the existing job and never starts a second build. The same `outputName` with a different request fails with `outputNameConflict`, and a name that already exists in the output folder fails the job with `alreadyExists` before discovery starts. To try again after a failure, use a new `outputName`.

## 3. Wait for the build

`context_builder` returns a job snapshot that contains a `jobId`. Call `context_job` with `{ "op": "wait", "jobId": "...", "durationMs": 50000 }`, choosing a `durationMs` below your client's tool-call timeout; Codex's default timeout is 60 seconds. While the job runs, the snapshot has `localSettled: false`: wait again on the same job. Discovery usually takes a few minutes.

When a wait ends, times out or is interrupted, the job keeps running. `{ "op": "status", "jobId": "..." }` returns the current snapshot without waiting, and `{ "op": "cancel", "jobId": "..." }` stops the job. When discovery asks a clarification question, a wait returns it as a form for the client to show the user; status never does.

A finished job's `state` is one of:

- `ready`: the packet is published. Go to step 4.
- `blocked`: the packet failed a check, such as its budget, and `validation` gives the reasons. Report this to the user.
- `failed` or `cancelled`: `code` gives the reason. Report it, and do not replace the build with context collected another way unless the user agrees.

Jobs belong to the connection. If the server restarts, its jobs are gone, but published bundles remain and step 5 can prepare them.

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
  "workspace": { "roots": [{ "name": "app", "absolutePath": "/repos/app" }], "outputRoot": "/repos/app/prompt-exports" },
  "bundle": "20261029-login-timeout-review",
  "prompt": "<the complete final task>",
  "outputName": "20261029-login-timeout-review-final"
}
```

Send the workspace that built the bundle. `bundle` is the ready bundle's folder name. `prompt` becomes the packet's last section word for word, replacing the prompt that discovery wrote, which the ready receipt shows as `prompt`. Write the complete task: the user's request, the roots and comparisons, the user's decisions, corrections from discovery, and the deliverable. Before publishing, mipmux checks every delivered material against the current files. A ready reply lists the materials it `added` and `removed` instead of the full list.

- A `sourceChanged` failure names a file that changed since the build. Send `refresh: true` to rebuild the packet from current files with the same selection. A packet that includes Git artifacts chosen by discovery (`gitPatch` or `gitMap` materials) cannot be refreshed and returns `refreshRequiresDiscovery`; start a new build instead.
- To add missing material, send `required`, `documents` or `patches`, in the forms that step 2 describes.
- To shrink the packet, `remove` optional files or Git artifacts, or `demote` optional files to code maps, naming each the way the receipt lists it: `root/path` for a file, or a Git artifact's alias. `budgetUnits` sets a budget the packet must fit; a packet over it returns `blocked` with `overBudget`.

## 6. Hand off the packet

Give the recipient the prepared bundle's `context.md`: its path if the recipient can read files, otherwise its contents. The file's last section, `user_instructions`, holds the task. Do not also send `manifest.json` or `handoff.md`; they are records for you.

Before sending, check that the packet fits the recipient's context window with room for its own instructions, tools and answer. Units are only an estimate: in one measurement, a packet of 181,000 units came to 303,000 Claude tokens. If the packet does not fit, ask the user whether to shrink it (step 5) or to split the task.

## Later runs and cleanup

To give a ready bundle a different task, prepare it again with a new prompt; while its files are unchanged, no discovery is needed. Start a new build when the scope, roots or comparisons change.

Builds that capture Git evidence store snapshots in `<output folder>/_git_data`, which every run in the project shares. mipmux deletes snapshots older than seven days and all but the newest 25, so preparing an older review bundle can fail; start a new build when it does. `context_job` with `{ "op": "dispose", "jobId": "..." }` deletes one job's snapshots when you no longer need its bundles.

To select context yourself instead of running discovery, use `draft_create`, `manage_selection`, `draft_validate` and `draft_finalize`. The server offers them when its `tools` setting is `"full"`; they are described in the README's [manual context packets](../README.md#manual-context-packets) section.

## Common mistakes

- Creating a new output folder for each run, which makes every run reread the whole workspace.
- Naming roots that the task does not need.
- Starting a new build because a wait returned before the job finished.
- Reading `context.md` into your own context.
- Sending a review packet without checking that it contains every changed file and the patch.
