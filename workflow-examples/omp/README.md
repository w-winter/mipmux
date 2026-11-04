# oh-my-pi workflow examples

These examples use oh-my-pi's (omp's) native task agents. Read the [workflow overview](../README.md) first, and build and configure mipmux using the [quickstart](../../README.md#quickstart).

## Connect mipmux

Add a server named `mipmux` to `~/.omp/agent/mcp.json`, merging it with your existing servers. Replace both executable paths:

```json
{
  "mcpServers": {
    "mipmux": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mipmux/dist/cli/main.js", "mcp"],
      "timeout": 60000
    }
  }
}
```

The timeout is in milliseconds. The skills wait for 50 seconds per MCP call, below this 60-second timeout, and repeat the wait while the job runs. [omp-mipmux](../../integrations/omp/README.md) optionally adds workspace selection and preferences.

## Install

From the root of a mipmux checkout, replace the project path and run:

```sh
project=/absolute/path/to/your/project
for skill in mipmux-example-review mipmux-example-plan; do
  mkdir -p "$project/.omp/skills/$skill"
  cp -i "workflow-examples/omp/skills/$skill/SKILL.md" "$project/.omp/skills/$skill/"
done
mkdir -p "$project/.omp/agents"
cp -i workflow-examples/omp/agents/*.md "$project/.omp/agents/"
```

Start a new omp session in that project. To install for every project instead, use `~/.omp/agent/skills/` and `~/.omp/agent/agents/`.

The skills use omp's default task settings, `task.batch: true` and `task.structured: false`. They dispatch each role inside a task batch with the packet's path, and read each answer from `agent://`, because an inline result may be only a preview. The roles set `tools: [read]` and `read-summarize: false` and read their packets in consecutive raw line ranges. omp's MCP and extension tools stay available to them, so the role prompts also forbid mipmux calls, edits and delegation.

## Try it

Replace the paths and commits with your own:

```text
/skill:mipmux-example-review <base commit>..<target commit> in /absolute/project
/skill:mipmux-example-plan how to add request cancellation in /absolute/project
```

## Models

The roles set no model, so each uses your active model, unless `task.agentModelOverrides` in omp's configuration names another for it. To choose one in a role, set `model` to a selector such as `openai-codex/gpt-6-astra`, or to a role alias such as `@review` that `modelRoles` in `~/.omp/agent/config.yml` maps to a model, and `thinking` to an effort level such as `high`. omp can give each role a model from any provider you are signed in to. omp 18.13.0 cannot choose a model for one dispatch: its task tool accepts `model` only for the bundled `seance` agent. When your request names models there, the skills ask whether to continue on the role's own model, which for planning means a single draft. omp's 18.16.0 documentation adds a per-item `model` to the task tool. It works only when your global omp settings set `task.perCallModel: on` and approve the model, for example as a `modelRoles` value (project settings cannot approve one), and not for a role that `task.agentModelOverrides` routes. [Advisors](../README.md#advisors) explains why the choice matters.

## Compatibility

Both skills ran end to end in omp 18.13.0 on 2026-11-04. The planning skill wrote a single draft, because that version accepts a per-dispatch model only for its `seance` agent (see [Models](#models)). Checked against installed omp 18.13.0 and omp's [agent discovery](https://github.com/can1357/oh-my-pi/blob/ef3293b64fbcbef7882430859f9685ddf5443ff5/docs/task-agent-discovery.md), [task](https://github.com/can1357/oh-my-pi/blob/ef3293b64fbcbef7882430859f9685ddf5443ff5/docs/tools/task.md), [skills](https://github.com/can1357/oh-my-pi/blob/ef3293b64fbcbef7882430859f9685ddf5443ff5/docs/skills.md) and [read](https://github.com/can1357/oh-my-pi/blob/ef3293b64fbcbef7882430859f9685ddf5443ff5/docs/tools/read.md) documentation on 2026-11-04.
