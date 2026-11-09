---
name: mipmux-example-plan
description: Research, draft, critique and finish an implementation plan with planner and critic subagents that read mipmux context packets. Use only when the user invokes this workflow.
disable-model-invocation: true
---

# Planning with mipmux packets

You coordinate the planning of the task the user names and produce one plan document. Explorer subagents map the code; mipmux's discovery agent collects the relevant source into a context packet; the planner subagent drafts a plan from that packet, once for each model the user names for it, or once on its own model; you write the plan from the drafts; a critic subagent checks the plan against the drafts and the code; you finish the plan. You own the writing, the structure and the user's decisions. This workflow ends at a plan and changes no product code.

Principles:

- **Delegate evidence, not voice.** Subagents gather evidence and draft; you write the plan.
- **The drafts are preservation baselines, not authorities over the code or the user's decisions.** Keep every supported implementation-bearing fact, decision, rationale, constraint, edge case, sequencing requirement and verification requirement. A detail is supported when the requirements, the code, the repository's established patterns or sound reasoning about the task justify it.
- **Removal needs evidence, and consolidation must lose nothing.** Remove or replace a draft's detail only when the code, the user or the task's scope shows it is wrong, unsupported, out of scope or duplicated, or when you can name a simpler design that meets the same requirements with the same verification. Never turn concrete detail into general advice such as "handle errors" or "update callers".
- **Reference, don't reproduce.** Cite `file:line` and links; don't paste source files, transcripts or tool output into the plan.
- **Ground every question in something you found.** Generic questions waste the user's time.

## Host mechanics

**mipmux.** Use Pi's built-in MCP server named `mipmux`. Its tools are `mcp__mipmux__context_builder`, `mcp__mipmux__context_job` and `mcp__mipmux__context_prepare`. Under Pi's default `codemode` exposure, call them from a `codemode` script, for example `const result = await tools.mcp__mipmux__context_builder({ ... })`; check `result.isError`, then parse mipmux's JSON from `result.content[0].text`. If the server's exposure is `direct`, call them as ordinary tools. Wait with `context_job` and `{ "op": "wait", "jobId": "...", "durationMs": 50000 }`, below Pi's default 60-second MCP request timeout, and make each wait its own call rather than a loop inside one script, so a message from the user reaches you between waits.

**Reading a file for `documents`.** Pi's `read` tool returns a long file in pages of up to 2,000 lines or 50 KB, and `tools.read` in a `codemode` script returns one such page. To pass a file's text as a document, read the file in a `codemode` script with `tools.bash`, for example `const file = await tools.bash({ command: "cat -- '/absolute/path'" })`. `file.output` holds up to 1 MiB. Use it only when `file.truncated` is false, and report a longer file to the user.

**Asking the user.** Ask in the conversation and end your turn until they answer.

**Explorers.** pi-interactive-subagents has no built-in explorer. Launch a `subagent` without `agent`, with `autoExit: true` and a task that asks one narrow question, names the roots, asks for `file:line` references, and forbids edits and proposals. Make several calls before ending your turn to run them in parallel.

**Dispatching a subagent.** Use the `subagent` tool from pi-interactive-subagents, whose arguments differ from nicobailon/pi-subagents'. For the first planner:

```json
{
  "name": "Draft 1",
  "agent": "mipmux-example-planner",
  "cwd": "/absolute/project",
  "inputFiles": ["/absolute/project/prompt-exports/<run-name>-plan/context.md"],
  "task": "Read the complete attached packet. Perform the assignment in its final user_instructions section and return the full plan as your final answer. Do not edit files."
}
```

`inputFiles` attaches the complete packet to the subagent's first prompt; an `@path` in task text does not. The role definitions start fresh, standalone sessions; do not set `fork: true`. A role that names no `model` uses the child Pi's startup model, which may differ from yours. To run several planners in parallel, make all their `subagent` calls, each with its own `name` and `model`, before ending your turn; their completion messages arrive separately.

**Choosing a model.** For one dispatch, the `subagent` tool takes `model`, as `provider/model-id`, and `thinking`, a level such as `high`. Set them only for a model or effort the user named.

**Receiving the answer.** The call returns a launch acknowledgement. End your turn or do independent work until the completion message arrives; do not poll logs, sleep, or list definitions as a status check. Because the roles set `auto-exit: true`, that message carries the subagent's complete final answer followed by `Session:` and `Resume:` lines. Save the answer without those lines, and keep the session path for diagnostics. A message saying the subagent failed, was interrupted or exited without output is not a deliverable.

**Help requests.** Subagents can call `caller_ping`, which ends their turn with a message saying they need help. Answer from the evidence you have, or ask the user when it needs their decision, then continue the subagent with `subagent_resume`, its session path and your answer.

## 1. Choose the user's involvement

Before exploring, ask the user how involved they want to be, unless their request already says:

| Mode | Where you pause for the user |
|---|---|
| Up front | Before broad exploration, for questions grounded in what the first explorers found |
| Mid-flow | After writing the plan from the drafts, before the critique |
| Hands-off | At the end, when the plan is ready |

If the user declines to choose, use Hands-off. Once they pick Up front or Mid-flow, that checkpoint is a promise: stop there until they answer, and do not continue on assumed answers. A question the user explicitly skips lets you continue with what you know. Ask two to four questions at a checkpoint, each about a real ambiguity you could not have named without the code or the drafts.

## 2. Map the seams

For Up front, first dispatch one or two explorers to find existing patterns behind the material ambiguities, then ask your questions and fold the answers in.

Then dispatch explorers in parallel to map what the plan will touch. Give each one narrow question, the absolute roots, and a request for findings with `file:line` references and no proposals:

- **In-workspace seams**, always: how the subsystem connects to adjacent code, its key types and extension points.
- **Prior work**, when the area has history: earlier plans and recent commits in it.
- **External research**, only when the plan depends on facts outside the repository, such as a library's behavior, and the explorer can reach them.

Do not read the code broadly yourself; keep your context for writing. Distill the findings the plan depends on and leave the raw transcripts behind.

## 3. Choose the workspace and names

When the session supplies a `mipmux_workspace` declaration (the pi-mipmux and omp-mipmux extensions add one when the user selects a saved workspace), use it unchanged in every mipmux call. Otherwise confirm the source roots with the user rather than assuming the current directory is the project. Name every root the task needs and no others.

Use one output folder, `prompt-exports/` in the primary root, for every run in the project, and create it if it is missing. mipmux never indexes it.

Choose an unused run name from the date and a short topic, such as `20261103-request-cancellation`. Bundle names are siblings that start with it, such as `<run-name>-discovery`, `<run-name>-plan` and `<run-name>-critic`, and the plan's working copy, the drafts, the ledger and the critique go in `<outputRoot>/<run-name>/`. Never overwrite an earlier run.

## 4. Scaffold the plan

Choose an unused final path for the plan: `docs/plans/<topic>-<YYYY-MM-DD>.md`, or the repository's own convention for plans. Until the plan is finished, keep it only as `plan.md` in the run's report folder, which mipmux never indexes, and write it to its final path in the last step. Discovery could select a plan file under a root, and your later edits to it would then make the critic's packet fail with `sourceChanged`.

Create the working copy with four sections: **Goal**, one or two sentences in the codebase's terms; **Background**, the distilled findings; **Open questions**; and **References**. Do not write the approach or work items yet; the planners produce those.

## 5. Collect planning context

Read the project's instructions, such as `AGENTS.md` or `CLAUDE.md`, and note the ones that govern the work. Then call `context_builder` with:

- `workspace`: `{ "roots": [{ "name": "...", "absolutePath": "..." }], "outputRoot": "..." }`, plus the selected declaration's `exclusions` if it has any.
- `purpose`: `"planning"`.
- `task`: the request in the codebase's terms, the roots, the user's answers so far, the plan's final path, and what the planners will need: the code the change touches, its callers, its tests and the conventions it must follow. Ask discovery to select and explain that code, not to plan.
- `outputName`: `<run-name>-discovery`.
- `documents`: the scaffold, as `{ "id": "plan-scaffold", "role": "plan", "origin": "<the working copy's path>", "text": "<the complete scaffold>" }`, and any text from outside the roots the plan depends on, with `role` `plan`, `report` or `evidence`. The working copy is in the output folder, so discovery sees the scaffold only as this document.
- `required`: files that must appear in full, such as an approved specification or the project instructions, as `{ "root": "...", "path": "..." }` with the path relative to the root.

Leave `budgetUnits`, `discovery`, `enhancementMode` and `clarification` unset unless the user asks for them.

`context_builder` returns a job snapshot with a `jobId`. Wait on that job as Host mechanics describes, and wait again while the snapshot shows `localSettled: false`. A wait that ends early, times out or is interrupted does not stop the job, so never start a second build because waiting is slow. If the user sends a message during a wait, respond to it before waiting again.

If a wait returns a `question`, give the user its message and choices and stop until they answer. Send only their answer, through `context_job`:

```json
{ "op": "answer", "jobId": "<job ID>", "questionId": "<question.id>", "response": { "action": "accept", "content": { "<schema property>": "<the user's answer>" } } }
```

Use a list of strings for an array-valued question, and `{ "action": "decline" }` only when the user skips it. `{ "op": "status", "jobId": "..." }` reads the snapshot without waiting, and `{ "op": "cancel", "jobId": "..." }` stops the job when the user asks.

A finished job's `state` is `ready`, `blocked`, `failed` or `cancelled`. Report anything other than `ready` and stop; do not replace discovery with context gathered another way. If the build call itself fails before returning a job, repeat it unchanged: the same workspace, request and `outputName` return the same job.

A ready snapshot's `bundle` describes the packet without its contents: `directory`, `context` (the path of `context.md`), `accounting`, `materials`, `omitted`, and the clarified `prompt`. Do not read `context.md` yourself; it is written for the planners and can run to hundreds of kilobytes. Check that the code the plan touches, its callers and tests are present, and decide for each `omitted` entry whether the plan can do without it.

## 6. Draft the plan

`context_prepare` gives a saved packet its final assignment and publishes a new bundle without a model call:

```json
{
  "workspace": { "roots": [{ "name": "app", "absolutePath": "/absolute/project" }], "outputRoot": "/absolute/project/prompt-exports" },
  "bundle": "<run-name>-discovery",
  "prompt": "<the complete planning assignment>",
  "outputName": "<run-name>-plan"
}
```

Send the workspace that built the bundle and the bundle's directory name from the receipt. The prompt replaces discovery's, so make it complete: the original request, the user's answers, the scaffold's goal and open questions, whatever discovery found that the planners need, and the deliverable. Ask for a complete, implementation-ready plan, not a short approach: current-state analysis, design, component and interface contracts, file-by-file impact, data and state flow, errors and edge cases, cancellation, risks, implementation order and verification, wherever they apply, returned as the planner's final answer. To add material, send `required` or `documents` in the forms the build takes; to shrink the packet, `remove` optional materials or `demote` files to code maps, naming them as the receipt does. Preparation checks every delivered material against the current files. On `sourceChanged` or any other failure, report it and stop rather than sending an unchecked packet.

Preparation's check covers the files under the roots. mipmux delivers each document's `text` as given and treats its `origin` as a label, so before you dispatch, compare every document whose `origin` names a file with that file. List the packet's documents from the `manifest.json` beside its `context.md`, for example with `jq -r '.materials[] | select(.kind == "document") | [.input.id, .input.origin, .identity.sha256] | @tsv' manifest.json`, and compare each hash with the file's SHA-256 from `shasum -a 256` or `sha256sum`. A mismatch means the packet holds other text, cut short or older than the file. Preparing a bundle again keeps its documents, so a wrong one needs a bundle without it: prepare the discovery bundle again with the complete text under a new `outputName`, or start a new build when the build itself received the document.

Dispatch `mipmux-example-planner` as Host mechanics describes: once for each model the user named for the planners, in parallel, with each dispatch's model set; or once on its own model when they named none. Give every dispatch the same packet and the same short instruction to perform the assignment in its final `user_instructions` section, and send nothing else. Save each complete answer unchanged as `draft-1.md`, `draft-2.md` and so on in the run's report folder, and note which model wrote each. If a planner fails or returns an incomplete draft, tell the user and ask whether to continue with the remaining drafts; do not substitute another model on your own.

Read every draft in full. Build a coverage ledger and save it as `ledger.md` in the report folder: each implementation-bearing fact, decision, rationale, constraint, behavior case, dependency and verification item, a few words apiece, with the draft it came from and what you did with it.

Write the plan in its working copy from the drafts, merging them when there are several, and fold in the scaffold's goal, background, open questions and references, and the user's answers. Check the drafts' claims against the code with targeted reads; correct or remove a detail only under the removal standard above, and record the reason so a correction does not later read as a loss. Add an execution index with **Goal**, **Done when**, **Key files**, **Dependencies** and **Size** for each work item. The index organizes the specification; it does not replace it.

## 7. Mid-flow check-in

For Mid-flow only: read your plan, give the user its working copy's path, and ask two to four questions about its material choices, such as a hedge, a tradeoff without a pick, or an assumption the user may want to weigh. Wait for the answers and fold them in.

## 8. Critique

Prepare a critic packet from the discovery bundle with `context_prepare` and `outputName` `<run-name>-critic`. Add the complete text of each draft and of the current plan as `documents` with `role` `plan`: `draft-1`, `draft-2` and so on, and `current-plan`, each with its file's path as `origin`. The assignment states the original requirements, names the documents, and asks for the bounded critique that the critic's role defines, returned as its final answer. These documents add to the packet's size; if it no longer fits the budget, `demote` or `remove` optional files the plan does not rely on, and tell the user what you cut. Before dispatching the critic, check these documents against their files as step 6 describes.

Dispatch `mipmux-example-plan-critic` once, as Host mechanics describes, using the model the user named for the critic, if any. Save its complete answer unchanged as `critique.md` in the report folder and read it in full. Verify its material claims with targeted reads. Apply the verified findings to the plan: restore supported omissions, resolve ambiguities and contradictions, and correct or remove content under the removal standard. Ask the user about findings that would change the scope or the requirements. Do not paste the critique into the plan, and do not let it reopen settled decisions without evidence, expand the scope or rewrite the plan.

## 9. Polish and audit

Make the plan clear and executable without losing content:

- Remove filler, raw artifacts and duplication, keeping any consolidation lossless.
- Keep concise rationale for the chosen approach and its most plausible rejected alternative when that rationale guides implementation or review.
- Verify every `file:line` reference, symbol, command and link the plan relies on.
- Scan for accidental generalization: phrases such as "update callers", "handle errors" or "add tests" must not replace named call sites, failure behavior or verification cases.

Walk the coverage ledger. Each item must be as explicit and easy to find in the plan as it was in its draft, consolidated without loss, or corrected or removed with a recorded reason. Restore anything that became weaker or merely implied, and check the drafts directly wherever the ledger is thin.

The finished plan stands alone. It covers the whole task, defines the boundary of the implementation, names the tests, commands and manual checks that prove completion, keeps only material open questions, and can be carried out by a reader who never saw this conversation. Write it to its final path.

For Hands-off, present the plan now and offer focused revisions. In every mode, report the plan's final path, a two- or three-sentence summary, the open questions that remain, and the paths of the drafts, ledger and critique. Stop at the plan: implementing it needs a separate request.

## When something fails

A launch acknowledgement, a preview or a summary is not a draft or a critique. If a subagent's answer is missing, cut short or failed, report the workflow as incomplete and keep its artifacts; do not quietly switch models or start the workflow again.

Keep the bundles, drafts, ledger and critique for the user, and do not stage them. Dispose of a mipmux job with `{ "op": "dispose", "jobId": "..." }` only when its Git snapshots are no longer needed. Jobs belong to the connection: after a reconnect, earlier job IDs are unknown, but published bundles remain and can still be prepared.
