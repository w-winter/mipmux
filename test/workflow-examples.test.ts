import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Users install one client folder on its own, so every folder carries its own copy of the shared instructions.
const examples = fileURLToPath(new URL('../../workflow-examples/', import.meta.url));
const roles = ['reviewer', 'planner', 'plan-critic'];
const skills = ['review', 'plan'];
const codexInstructions = "developer_instructions = '''\n";
const frontmatterEnd = '\n---\n';
// The one section of a skill that differs between clients: how it calls mipmux, dispatches subagents and reads answers.
const hostSectionStart = '\n## Host mechanics\n';

/** What a role definition tells its subagent: Codex's `developer_instructions` literal string, or the Markdown body. */
function roleInstructions(client: string, role: string): string {
  const name = `mipmux-example-${role}`;
  if (client === 'codex') {
    const text = readFileSync(join(examples, client, 'agents', `${name}.toml`), 'utf8');
    const start = text.indexOf(codexInstructions), end = text.lastIndexOf("'''");
    assert.ok(start >= 0 && end > start, `${client}/${name}.toml has no developer_instructions literal string`);
    return text.slice(start + codexInstructions.length, end).trim();
  }
  return markdownBody(join(examples, client, 'agents', `${name}.md`));
}

function markdownBody(path: string): string {
  const text = readFileSync(path, 'utf8');
  const end = text.indexOf(frontmatterEnd, 3);
  assert.ok(text.startsWith('---\n') && end > 0, `${path} has no frontmatter`);
  return text.slice(end + frontmatterEnd.length).trim();
}

/** A skill's shared text: its body without the Host mechanics section, which runs to the next level-two heading. */
function sharedSkillText(client: string, skill: string): string {
  const body = markdownBody(join(examples, client, 'skills', `mipmux-example-${skill}`, 'SKILL.md'));
  const start = body.indexOf(hostSectionStart);
  const end = body.indexOf('\n## ', start + hostSectionStart.length);
  assert.ok(start >= 0 && end > start, `${client}'s ${skill} skill has no Host mechanics section followed by another section`);
  return body.slice(0, start) + body.slice(end);
}

test('every client folder gives the subagents and the coordinator the same instructions', () => {
  const [first, ...others] = readdirSync(examples, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  assert.ok(first !== undefined && others.length > 0, 'workflow-examples has no client folders to compare');
  for (const client of others) {
    for (const role of roles) {
      assert.equal(roleInstructions(client, role), roleInstructions(first, role), `${client}'s ${role} differs from ${first}'s`);
    }
    for (const skill of skills) {
      assert.equal(sharedSkillText(client, skill), sharedSkillText(first, skill),
        `${client}'s ${skill} skill differs from ${first}'s outside Host mechanics`);
    }
  }
});
