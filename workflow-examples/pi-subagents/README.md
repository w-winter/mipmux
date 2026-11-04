# pi-subagents workflow examples

Read the [workflow overview](../README.md) first. These examples are for pi-subagents. The pi-interactive-subagents extension also provides a `subagent` tool, with different arguments, and has [its own examples](../pi-interactive-subagents/README.md).

## Prerequisites

Install [pi-subagents](https://github.com/nicobailon/pi-subagents):

```sh
pi install npm:pi-subagents
```

Use Pi 1.5.0 or newer, and connect mipmux through Pi's built-in MCP support as a server named `mipmux`, as the [quickstart](../../README.md#quickstart) shows. The [pi-mipmux](../../integrations/pi/README.md) extension is optional. With it, a message you send while the agent waits for discovery reaches the agent at once, and `/mipmux` can select a saved workspace. Without it, the message arrives when the current wait ends, within 50 seconds.

## Install

From the root of a mipmux checkout, replace the project path and run:

```sh
project=/absolute/path/to/your/project
for skill in mipmux-example-review mipmux-example-plan; do
  mkdir -p "$project/.pi/skills/$skill"
  cp -i "workflow-examples/pi-subagents/skills/$skill/SKILL.md" "$project/.pi/skills/$skill/"
done
mkdir -p "$project/.pi/agents"
cp -i workflow-examples/pi-subagents/agents/*.md "$project/.pi/agents/"
```

Start Pi in that project, trust its configuration after inspecting it, and run `/reload` if the session was already open. To install for every project instead, use `skills/` and `agents/` in Pi's agent folder, normally `~/.pi/agent`, or `$PI_CODING_AGENT_DIR` when it is set.

The roles use YAML `name`, `description`, a comma-separated `tools` list of read and search tools, `acceptanceRole: read-only` and `inheritProjectContext: true`; the empty `extensions:` field keeps other extensions out of the subagents. The skills start each subagent with a fresh context and an `output` path. pi-subagents has no way to attach a file, so each subagent reads its packet from the path it is given, and pi-subagents saves its complete final answer at `output`.

## Try it

Replace the paths and commits with your own:

```text
/skill:mipmux-example-review <base commit>..<target commit> in /absolute/project
/skill:mipmux-example-plan how to add request cancellation in /absolute/project
/skill:mipmux-example-plan how to add request cancellation in /absolute/project, drafted by <provider/model-id> and <provider/model-id>
```

If you selected a workspace with `/mipmux`, it must include the task's source roots.

## Models

The roles set no model, so your pi-subagents role and session defaults apply. To choose one in a role, set `model` and `thinking`, an effort level such as `high`, in its frontmatter, or set them for the role in your pi-subagents settings. Pi can give each role a model from any provider you are signed in to. When your request names a model for a subagent, the skills pass it as the `subagent` tool's `model` for that dispatch, with a suffix such as `:high` for any effort you name. [Advisors](../README.md#advisors) explains why the choice matters.

## Compatibility

Both skills ran end to end in Pi 1.5.0 with pi-subagents 0.84.0 and without pi-mipmux, on 2026-11-04. Checked against pi-subagents' [agent documentation](https://github.com/nicobailon/pi-subagents/blob/8520aeb788ca19479baa852b5a7884a86bed813e/docs/agents.md), [tool schema](https://github.com/nicobailon/pi-subagents/blob/8520aeb788ca19479baa852b5a7884a86bed813e/src/extension/schemas.ts), [completion notices](https://github.com/nicobailon/pi-subagents/blob/8520aeb788ca19479baa852b5a7884a86bed813e/docs/configuration.md#waittool) and [answer handling](https://github.com/nicobailon/pi-subagents/blob/8520aeb788ca19479baa852b5a7884a86bed813e/src/runs/shared/single-output.ts), package version 0.84.0, on 2026-11-04.
