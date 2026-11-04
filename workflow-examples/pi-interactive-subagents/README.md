# pi-interactive-subagents workflow examples

Read the [workflow overview](../README.md) first. These examples are for pi-interactive-subagents. The pi-subagents extension also provides a `subagent` tool, with different arguments, and has [its own examples](../pi-subagents/README.md).

## Prerequisites

Install the [w-winter fork of pi-interactive-subagents](https://github.com/w-winter/pi-interactive-subagents), and run Pi inside one of its supported terminal multiplexers:

```sh
pi install git:github.com/w-winter/pi-interactive-subagents
```

Use Pi 1.5.0 or newer, and connect mipmux through Pi's built-in MCP support as a server named `mipmux`, as the [quickstart](../../README.md#quickstart) shows. The [pi-mipmux](../../integrations/pi/README.md) extension is optional. With it, a message you send while the agent waits for discovery reaches the agent at once, and `/mipmux` can select a saved workspace. Without it, the message arrives when the current wait ends, within 50 seconds.

## Install

From the root of a mipmux checkout, replace the project path and run:

```sh
project=/absolute/path/to/your/project
for skill in mipmux-example-review mipmux-example-plan; do
  mkdir -p "$project/.pi/skills/$skill"
  cp -i "workflow-examples/pi-interactive-subagents/skills/$skill/SKILL.md" "$project/.pi/skills/$skill/"
done
mkdir -p "$project/.pi/agents"
cp -i workflow-examples/pi-interactive-subagents/agents/*.md "$project/.pi/agents/"
```

Start Pi in that project, trust its configuration after inspecting it, and run `/reload` if the session was already open. To install for every project instead, use `skills/` and `agents/` in Pi's agent folder, normally `~/.pi/agent`, or `$PI_CODING_AGENT_DIR` when it is set.

The roles use scalar YAML fields: `extension: pi-interactive-subagents`, `name`, `description`, a comma-separated `tools` list (lists in YAML array form are not valid for this extension), `session-mode: standalone`, `spawning: false`, `auto-exit: true` and `system-prompt: append`. The skills attach each prepared packet with `inputFiles` and save the complete answer from the completion message.

## Try it

Replace the paths and commits with your own:

```text
/skill:mipmux-example-review <base commit>..<target commit> in /absolute/project
/skill:mipmux-example-plan how to add request cancellation in /absolute/project
/skill:mipmux-example-plan how to add request cancellation in /absolute/project, drafted by <provider/model-id> and <provider/model-id>
```

If you selected a workspace with `/mipmux`, it must include the task's source roots.

## Models

The roles set no model, so each child uses its own Pi startup model, which may differ from the model you are using. To choose one in a role, set `model` to `provider/model-id` and `thinking` to an effort level such as `high`. Pi can give each role a model from any provider you are signed in to. When your request names a model for a subagent, the skills pass it, with any effort you name, as the `subagent` tool's `model` and `thinking` for that dispatch. [Advisors](../README.md#advisors) explains why the choice matters.

## References

Checked against the fork's [definition parser](https://github.com/w-winter/pi-interactive-subagents/blob/cae3d7b9277851fbcf64cd3b6fe53e8dba14154f/pi-extension/subagents/agent-definitions.ts) and [dispatch and result handling](https://github.com/w-winter/pi-interactive-subagents/blob/cae3d7b9277851fbcf64cd3b6fe53e8dba14154f/pi-extension/subagents/index.ts), package version 3.7.2, on 2026-11-04.
