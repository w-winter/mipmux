# Claude Code workflow examples

Read the [workflow overview](../README.md) first, and connect mipmux to Claude Code using the [quickstart](../../README.md#quickstart).

## Install

From the root of a mipmux checkout, replace the project path and run:

```sh
project=/absolute/path/to/your/project
for skill in mipmux-example-review mipmux-example-plan; do
  mkdir -p "$project/.claude/skills/$skill"
  cp -i "workflow-examples/claude-code/skills/$skill/SKILL.md" "$project/.claude/skills/$skill/"
done
mkdir -p "$project/.claude/agents"
cp -i workflow-examples/claude-code/agents/*.md "$project/.claude/agents/"
```

Start a new Claude Code session in that project. To install for every project instead, use `~/.claude/skills/` and `~/.claude/agents/`.

Both skills run in the main session and set `disable-model-invocation: true`, so they start only when you invoke them. The roles have `Read`, `Grep` and `Glob`; they return their answers, and the coordinator saves them.

## Try it

Replace the paths and commits with your own:

```text
/mipmux-example-review <base commit>..<target commit> in /absolute/project
/mipmux-example-plan how to add request cancellation in /absolute/project
/mipmux-example-plan how to add request cancellation in /absolute/project, drafted by opus and sonnet
```

## Models

Each role sets `model: inherit`, which uses the main session's model. To choose another, set `model` to an alias such as `opus` or a full model ID, and `effort` to `low`, `medium`, `high`, `xhigh` or `max`, as the model supports. Claude Code subagents use Claude models. When your request names a model for a subagent, the skills pass it as the `Agent` tool's `model` for that dispatch, which takes only an alias, together with any `effort` you name (Claude Code 2.1.292 or later). [Advisors](../README.md#advisors) explains why the choice matters.

## Compatibility

Both skills ran end to end in Claude Code 2.1.308 on 2026-11-04. Checked against Claude Code's [subagent reference](https://code.claude.com/docs/en/sub-agents), [skill reference](https://code.claude.com/docs/en/skills) and [tool reference](https://code.claude.com/docs/en/tools-reference) on 2026-11-04.
