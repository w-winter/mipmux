# Multi-agent workflow examples

These examples show how a coding agent can use mipmux to hand a review or a planning task to other models. Your main agent coordinates. It asks mipmux's discovery agent to collect the relevant code into a context packet, checks the packet's receipt, gives the packet its final assignment, and dispatches a subagent to read it. The subagent writes the review or plan, and your agent checks the result and saves it. Your agent never reads the packet itself, so its own context stays free for coordinating.

The workflows and role prompts are adapted from the multi-agent workflows of RepoPrompt Classic, which are now carried in [RepoPrompt CE](https://github.com/repoprompt/repoprompt-ce)'s `Sources/RepoPromptShared/Workflows/`. The review skill follows its `rp-review` workflow, and the planning skill and plan critic follow `rp-deep-plan`.

The review, planning and critique criteria are deliberately minimal placeholders for your own standards. They take a few positions against habits common in current models: they prefer a few verified findings to many speculative ones, tests whose failure would show a real defect to more tests, and one code path to fallbacks and compatibility branches that nothing requires. Try them on a small task, then edit your installed copies to match how you work.

## Advisors

The reviewer, the planner and the plan critic are "advisors" (also referred to as "oracles" in Amp Code, RepoPrompt, pi-subagents, and so on): separate models, each given a prepared packet, whose answers the coordinating agent weighs before it acts. Context Builder exists to give an advisor the code it needs and as little else as possible.

The role definitions set no model or reasoning effort, so each runs on your defaults. Advisors often do better with a high reasoning effort, and with a model from a different family, ideally from a different lab, than the agent that wrote the code or will carry out the plan, because such a model is less likely to share that agent's blind spots. This matters most for review. Pi, pi-subagents and oh-my-pi can give each role a model from any provider you are signed in to; Claude Code and Codex subagents use models from the session's own provider. Each setup's README names the fields to set, and it is worth experimenting with them.

An advisor's context window must hold its whole packet, plus its own instructions, tools and answer. mipmux caps each packet at a budget in estimated units, set by `contextBudgetUnits` in its configuration or `budgetUnits` on a request (see [Budget](../docs/packets.md#budget)). A unit is about 3.8 bytes of text, close to OpenAI's token counts: on packets from these examples, OpenAI's `o200k_base` tokenizer counted about 0.9 tokens per unit. Claude models count the same text as more tokens: one 181,000-unit packet came to about 303,000 Claude tokens, or 1.7 per unit. When an advisor runs on a Claude model, choose a budget that leaves room at that rate, by lowering `contextBudgetUnits` or by asking for a smaller budget in your request.

One role definition can also act as a council of advisors: the coordinator dispatches it several times, with a different model each time, and combines the answers. The planning skill does this when your request names models for the planners; otherwise it asks the planner for a single draft on the role's own model. With models named, it collects one draft per model from the same packet, merges the drafts into one plan, and has the critic check the plan against every draft. Models from different families make the drafts more independent. Claude Code, Codex and both Pi extensions can set a model for each dispatch; oh-my-pi needs a version and settings that allow it, as [its README](omp/README.md) explains.

## Example setups

- [pi-interactive-subagents](pi-interactive-subagents/README.md), using the w-winter fork.
- [pi-subagents](pi-subagents/README.md), by nicobailon.
- [oh-my-pi](omp/README.md), using its native task agents.
- [Claude Code](claude-code/README.md), using custom subagents.
- [Codex](codex/README.md), using custom agents.

Each folder has two coordinator skills and three role definitions:

| Name | Kind | What it does |
|---|---|---|
| `mipmux-example-review` | Skill | Reviews a Git comparison with one reviewer and saves the report. |
| `mipmux-example-plan` | Skill | Maps the code, has the planner draft a plan (one draft, or one for each model you name), writes the plan from the drafts, has the critic check it, and finishes the plan. |
| `mipmux-example-reviewer` | Role | Reviews the change in its packet. |
| `mipmux-example-planner` | Role | Drafts a plan from its packet. |
| `mipmux-example-plan-critic` | Role | Checks the plan against the drafts, the requirements and the code. |

Install only the version for your setup. The two Pi extensions use the same agent folder and tool name, so use one of them per session.

## Prerequisites

Build and configure mipmux using the [quickstart](../README.md#quickstart), including credentials for its discovery model, and connect it to your main agent as an MCP server named `mipmux`. The [configuration guide](../docs/configuration.md) covers discovery models and providers; the discovery model is configured separately from the subagents' models.

The examples run on one machine, where the coordinator and the subagents can read the same absolute paths. The [pi-mipmux](../integrations/pi/README.md) and [omp-mipmux](../integrations/omp/README.md) extensions are optional. They let you choose a saved workspace and build preferences for the agent's mipmux calls, and pi-mipmux also lets a message you send while the agent waits for discovery reach it at once.

## The review workflow

```text
main agent -> survey the change and confirm the comparison
main agent -> context_builder -> check receipt -> context_prepare with the review assignment
reviewer   -> read the prepared context.md -> full review
main agent -> check the findings -> save review.md
```

The review ends with a report; fixing the findings is a separate request. If the review names an area it could not cover, the coordinator collects context for that area once more and dispatches the reviewer again. When you fix findings and ask for another review, the coordinator gives the reviewer the earlier review and what was done about each finding, and tells you when successive rounds stop reducing the blocking findings.

## The planning workflow

```text
main agent -> ask how involved you want to be
explorers  -> map the code the plan will touch
main agent -> scaffold the plan in the run folder -> context_builder -> check receipt
main agent -> context_prepare with the planning assignment
planner    -> one draft, or one per model you name, from the same packet
main agent -> coverage ledger -> write the plan from the drafts
main agent -> context_prepare with the drafts and the plan
critic     -> read the prepared context.md -> full critique
main agent -> apply verified findings -> polish -> check the plan against the ledger
main agent -> write the plan to docs/plans/<topic>-<date>.md
```

You choose where the coordinator pauses for you: before exploration, before the critique, or only at the end. The plan is the deliverable, and the workflow stops there. The coordinator keeps the drafts, the coverage ledger, the critique and its working copy of the plan in the run's folder under `prompt-exports/`, which mipmux never indexes, so discovery cannot select a plan that is still being edited. It writes the finished plan where the repository keeps its plans.

Preparing the planner and critic packets reuses discovery's selection without another discovery run. Preparation rechecks the saved evidence against the current files, so keep the source stable during a run.

## Customize the roles

Edit your installed copies, not this checkout, so updating mipmux does not replace your prompts. The install commands use `cp -i`, which asks before overwriting a file.

Each role has sections the coordinator relies on and a section that is yours to change. In the reviewer, replace **Review criteria** with your own priorities, severity levels, finding format and evidence requirements. In the planner, replace **Planning criteria** with the sections and decisions your implementers need. The plan critic's **Critique** section checks for content the plan lost from a draft, under-specified or incorrect parts of the plan, details the code disproves or the task does not need, and missing failure handling; adapt it to your process if you need to.

Keep **Reading the packet**, the critic's **Before the critique**, and each closing **Delivering** section. The coordinator relies on the subagents reading the whole packet, reporting missing context, leaving decisions to you, and returning the full deliverable as their final answer. A comment at the top of each definition says which sections to replace and which to keep; the subagent does not see it. For Codex, the role text is the TOML `developer_instructions` string; in the other definitions, it is the Markdown body below the YAML frontmatter.

Each skill is one `SKILL.md`, and its **Host mechanics** section holds everything specific to the agent application: how to call mipmux and wait, how to dispatch a subagent, and how to read its answer. The Codex skills also include `agents/openai.yaml`, which makes them start only when invoked.

The roles are asked not to edit files or delegate. The Pi and Claude Code definitions select only file-reading and search tools; the oh-my-pi definitions select its read tool, but its MCP and extension tools stay available; Codex agents inherit the parent session's permissions. These instructions and tool lists are not a security sandbox; use your agent application's permission controls for untrusted projects.

## Check a first run

Start with a small change or a bounded planning request. For a review, Git's `<base>..<target>` notation names a commit range without ambiguity: it covers the commits after `<base>`, up to and including `<target>`.

Check that the main agent calls mipmux, that each subagent reads its whole packet, and that the saved review or plan covers the task. For planning, also check that the critic's packet holds every draft and the plan, and that the final plan accounts for the critic's findings. A successful launch alone does not show that the workflow finished.

For mipmux's side of these workflows, see the [workflow guide for agents](../docs/workflow.md) and the [reference for its MCP tools](../docs/mcp-tools.md).
