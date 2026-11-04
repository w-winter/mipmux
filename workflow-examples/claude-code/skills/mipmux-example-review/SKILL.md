---
name: mipmux-example-review
description: Review an explicit Git comparison with a reviewer subagent that reads a mipmux context packet. Use only when the user invokes this workflow.
disable-model-invocation: true
---

# Review with a mipmux packet

You coordinate a review of the change the user names. mipmux's discovery agent collects the code the change touches into a context packet; the `mipmux-example-reviewer` subagent reads that packet and writes the review; you check its findings and save the report. You do not review the code yourself, and this workflow changes no product code.

## Host mechanics

**mipmux.** Call the `mipmux` server's `context_builder`, `context_job` and `context_prepare` tools. Wait with `context_job` and `{ "op": "wait", "jobId": "...", "durationMs": 50000 }`.

**Asking the user.** Ask in the conversation and end your turn until they answer.

**Dispatching a subagent.** Use the `Agent` tool with the role's name as `subagent_type` and a prompt that gives the prepared packet's absolute path:

```text
Read /absolute/project/prompt-exports/<run-name>-review/context.md completely, continuing all truncated reads. Perform the assignment in its final user_instructions section. Return the complete review as your final answer. Do not edit files.
```

The path tells the subagent what to read with its `Read` tool; it is not an attachment. Do not fork the conversation or start an agent-team teammate.

**Choosing a model.** For one dispatch, the `Agent` tool's `model` parameter takes a model alias such as `opus`, `sonnet` or `haiku`, and its `effort` parameter, when the tool has one, takes a level such as `high`. Set them only for a model or effort the user named. The parameter takes no full model ID, and Claude Code subagents run only Claude models; if the user names another, say so before dispatching.

**Receiving the answer.** The subagent runs in the background; wait for its completion notification. The notification's `<result>` holds the complete answer with characters such as `<`, `>` and `&` escaped as HTML entities. Restore them when you save the answer, so the saved file matches what the subagent wrote. The notification's `<output-file>` is the subagent's JSON transcript, not a clean copy of the answer.

## 1. Survey the change

Check the Git state of each repository the request concerns: status, the current branch, recent commits, and the files the comparison changes. That is enough for this step; leave reading the code to discovery and the reviewer.

## 2. Confirm the comparison

Use the comparison the user's request names. If it is ambiguous or missing, offer the likely choices for the current branch and stop until the user answers:

- uncommitted work: the working tree against `HEAD`, with or without untracked files;
- staged changes against `HEAD`;
- a commit range `<base>..<target>`, which covers the commits after `<base>` up to and including `<target>`;
- the current branch against its trunk, as the range from their merge base to the branch.

A task that spans several repositories needs one comparison per repository. Note deleted files: they reach the reviewer through the patch.

Read the project's instructions, such as `AGENTS.md` or `CLAUDE.md`, and note the ones that govern the review; they go into the packet.

## 3. Choose the workspace and names

When the session supplies a `mipmux_workspace` declaration (the pi-mipmux and omp-mipmux extensions add one when the user selects a saved workspace), use it unchanged in every mipmux call. Otherwise confirm the source roots with the user rather than assuming the current directory is the project. Name every root the task needs and no others.

Use one output folder, `prompt-exports/` in the primary root, for every run in the project, and create it if it is missing. mipmux never indexes it. Before capturing a patch, make sure Git ignores it, and explain any ignore-file edit to the user first.

Choose an unused run name from the date and a short topic, such as `20261103-login-timeout`. Bundle names are siblings that start with it, such as `<run-name>-discovery` and `<run-name>-review`, and reports go in `<outputRoot>/<run-name>/`. Never overwrite an earlier run.

## 4. Collect review context

Call `context_builder` with:

- `workspace`: `{ "roots": [{ "name": "...", "absolutePath": "..." }], "outputRoot": "..." }`, plus the selected declaration's `exclusions` if it has any.
- `purpose`: `"review"`.
- `task`: the user's request, the roots, each comparison, the changed and deleted files, the project rules that govern the review, and who will read the packet. Ask discovery to select the changed code, the code around it and its tests, and to explain how they relate; not to review it.
- `outputName`: `<run-name>-discovery`.
- `patches`: one per repository, with the exact comparison:

  ```json
  { "id": "review", "root": "app", "comparison": { "kind": "commits", "base": "<base commit>", "target": "<target commit>" } }
  ```

  The other comparisons are `{ "kind": "worktree", "base": "HEAD", "includeUntracked": true }` and `{ "kind": "staged", "base": "HEAD" }`. Omit `paths` to cover the whole comparison, or give root-relative paths to narrow it.
- `required`: files that must appear in full, such as an approved plan or the project instructions, as `{ "root": "...", "path": "..." }` with the path relative to the root. With a `commits` or `staged` comparison, every file the packet includes from that root must match the comparison's target (the target commit, or the index for `staged`); a required file with other changes, such as uncommitted edits, blocks the packet with `sourceComparisonMismatch`. Pass such a file's text in `documents` instead.
- `documents`: text from outside the roots, such as a ticket, as `{ "id": "...", "role": "evidence", "origin": "...", "text": "..." }`, where `role` is `plan`, `report` or `evidence` and `text` is the full text.

Leave `budgetUnits`, `discovery`, `enhancementMode` and `clarification` unset unless the user asks for them. A review packet includes its patches by default.

## 5. Wait for the build

`context_builder` returns a job snapshot with a `jobId`. Wait on that job as Host mechanics describes, and wait again while the snapshot shows `localSettled: false`. A wait that ends early, times out or is interrupted does not stop the job, so never start a second build because waiting is slow. If the user sends a message during a wait, respond to it before waiting again.

If a wait returns a `question`, give the user its message and choices and stop until they answer. Send only their answer, through `context_job`:

```json
{ "op": "answer", "jobId": "<job ID>", "questionId": "<question.id>", "response": { "action": "accept", "content": { "<schema property>": "<the user's answer>" } } }
```

Use a list of strings for an array-valued question, and `{ "action": "decline" }` only when the user skips it. `{ "op": "status", "jobId": "..." }` reads the snapshot without waiting, and `{ "op": "cancel", "jobId": "..." }` stops the job when the user asks.

A finished job's `state` is `ready`, `blocked`, `failed` or `cancelled`. Report anything other than `ready` and stop; do not replace discovery with context gathered another way. If the build call itself fails before returning a job, repeat it unchanged: the same workspace, request and `outputName` return the same job.

## 6. Check the receipt and prepare the assignment

A ready snapshot's `bundle` describes the packet without its contents: `directory`, `context` (the path of `context.md`), `accounting`, `materials`, `omitted`, and the clarified `prompt`. Do not read `context.md` yourself; it is written for the reviewer and can run to hundreds of kilobytes. Check that every changed file and each requested patch is present, and decide for each `omitted` entry whether the review can do without it.

`context_prepare` gives the saved packet its final assignment and publishes a new bundle without a model call:

```json
{
  "workspace": { "roots": [{ "name": "app", "absolutePath": "/absolute/project" }], "outputRoot": "/absolute/project/prompt-exports" },
  "bundle": "<run-name>-discovery",
  "prompt": "<the complete review assignment>",
  "outputName": "<run-name>-review"
}
```

Send the workspace that built the bundle and the bundle's directory name from the receipt. The prompt replaces discovery's, so make it complete: the user's request, the roots, the comparison, the changed and deleted files, the project rules, whatever discovery found that the reviewer needs, and the deliverable, a full review returned as the reviewer's final answer. To add material, send `required`, `patches` or `documents` in the forms the build takes; to shrink the packet, `remove` optional materials or `demote` files to code maps, naming them as the receipt does. Preparation checks every delivered material against the current files. On `sourceChanged` or any other failure, report it and stop rather than sending an unchecked packet.

## 7. Dispatch the reviewer

Dispatch `mipmux-example-reviewer` with the prepared packet, as Host mechanics describes, using the model the user named for the reviewer, if any. Send only the packet and the short instruction to perform the assignment in its final `user_instructions` section; do not also send receipts or a second version of the assignment.

## 8. Save and check the review

Save the reviewer's complete answer, unchanged, to `<outputRoot>/<run-name>/review.md`, and read it in full. Check that it covers the whole comparison and says what it could not read. Verify the important findings against the diff and source with targeted reads, and separate the defects you confirmed from the ones you could not. Neither accept nor reject a finding merely because of how confidently it is stated. A review that finds nothing is a valid result, not a reason to review again.

## 9. Fill one gap if needed

If the review names a required area it could not cover, collect context for that area once more: a new build with the same comparison, whose task says what the first review covered and what it did not. Prepare it, dispatch the reviewer again, and save its answer as `review-2.md`. Do this at most once; if coverage is still incomplete, report what remains.

## 10. Report

Give the user the report paths, the findings with what you verified, and the coverage limits. Stop there: fixing the findings needs a separate request.

## Reviewing again after fixes

When the user fixes findings and asks for another review, run this workflow again as a new run whose comparison covers the fixes. Pass each earlier `review.md` and a ledger of its findings as `documents` with `role` `report`: for each finding, whether it was fixed, rejected with evidence or deferred, and what changed. The assignment asks the reviewer to check those corrections and any regressions they introduced, and not to reopen a settled finding without new evidence from the source.

Fix-and-review rounds should converge: each one should remove blocking findings or lower the highest severity. Compare the new review with the earlier ones. When two consecutive rounds improve neither, or new findings keep appearing in the same mechanism, tell the user that the fixes are not converging and that the approach may need rethinking, rather than recommending another round.

## When something fails

A launch acknowledgement, a preview or a summary is not a review. If the reviewer's answer is missing, cut short or failed, report the workflow as incomplete and keep its artifacts; do not quietly switch models or start the workflow again.

Keep the bundles and reports for the user, and do not stage them. Dispose of a mipmux job with `{ "op": "dispose", "jobId": "..." }` only when its Git snapshots are no longer needed. Jobs belong to the connection: after a reconnect, earlier job IDs are unknown, but published bundles remain and can still be prepared.
