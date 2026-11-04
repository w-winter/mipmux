# Codex workflow examples

Read the [workflow overview](../README.md) first, and connect mipmux to Codex using the [quickstart](../../README.md#quickstart).

## Install

From the root of a mipmux checkout, replace the project path and run:

```sh
project=/absolute/path/to/your/project
for skill in mipmux-example-review mipmux-example-plan; do
  mkdir -p "$project/.agents/skills/$skill/agents"
  cp -i "workflow-examples/codex/skills/$skill/SKILL.md" "$project/.agents/skills/$skill/"
  cp -i "workflow-examples/codex/skills/$skill/agents/openai.yaml" "$project/.agents/skills/$skill/agents/"
done
mkdir -p "$project/.codex/agents"
cp -i workflow-examples/codex/agents/*.toml "$project/.codex/agents/"
```

Start a new Codex session in that project. To install for every project instead, use `~/.agents/skills/` and `~/.codex/agents/`.

Codex loads a project's `.codex/agents` only when you trust the project, and subagents must be enabled (`agents.enabled` in Codex's configuration). Codex's terminal interface works through a background service that reads project trust when the service starts. If you trust the project while the service is already running, new sessions keep warning that project-local config is disabled, and the project's agents do not load; the warning says to restart the service with `/daemon`. `codex exec` reads the configuration afresh, so it loads the agents as soon as the project is trusted.

Select a skill with `/skills` or mention it with `$`. Each skill's `agents/openai.yaml` sets `policy.allow_implicit_invocation: false`, so the skills start only when you invoke them. Each role is a standalone TOML file with `name`, `description` and `developer_instructions`. A subagent inherits the session's sandbox and permissions; its instruction not to edit files is not a separate read-only sandbox.

## Try it

Replace the paths and commits with your own:

```text
$mipmux-example-review <base commit>..<target commit> in /absolute/project
$mipmux-example-plan how to add request cancellation in /absolute/project
$mipmux-example-plan how to add request cancellation in /absolute/project, drafted by <model> and <model>
```

## Models

The roles set no model, so a subagent uses the session's model and reasoning effort, or the defaults in the `[agents]` table of Codex's configuration. To choose another for a role, set `model` and `model_reasoning_effort` together in its TOML file. Codex subagents use models from the session's provider. When your request names a model for a subagent, the skills pass it, with any effort you name, as `spawn_agent`'s `model` and `reasoning_effort` for that dispatch. [Advisors](../README.md#advisors) explains why the choice matters.

## References

Checked on 2026-11-04 against Codex's [custom-agent documentation](https://developers.openai.com/codex/subagents) and [skill documentation](https://developers.openai.com/codex/skills), and Codex 0.166.0's [agent-file parser](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/agent-roles/src/agent_role_config.rs) and [subagent tool schemas](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs).
