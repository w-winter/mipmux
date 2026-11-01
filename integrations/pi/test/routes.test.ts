import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appDeclaration, context, instance, stateEntry } from './fixtures.ts';
import type { CallArgs, SessionState } from '../src/state.ts';

const pinnedBudget: SessionState = { selected: 'app', preferences: { budgetUnits: { value: 150000, pinned: true } }, lastDeclared: null };
const build = (fields: CallArgs = {}): CallArgs => ({ workspace: structuredClone(appDeclaration), purpose: 'planning', task: 'Plan',
  outputName: 'run-1', ...fields });

async function selected(state: SessionState = pinnedBudget) {
  const fixture = await instance();
  const session = context([stateEntry(state, 'e1')]);
  await fixture.mipmux.restore(session.ctx);
  return { ...fixture, ...session };
}

test('every adapter route that carries mipmux arguments is rewritten in place', async () => {
  const { mipmux, ctx } = await selected();
  const expected = build({ budgetUnits: 150000 });
  const routes = [
    { toolName: 'mcp', input: { tool: 'context_builder', server: 'mipmux', args: build() } },
    { toolName: 'mcp', input: { tool: 'mipmux_context_builder', args: build() } },
    { toolName: 'mcp', input: { tool: 'mcp__mipmux__context_builder', server: 'mipmux', args: build() } },
    { toolName: 'mcp__mipmux', input: { tool: 'context_builder', args: build() } },
    { toolName: 'mcp__mipmux__context_builder', input: build() },
    { toolName: 'mipmux_context_builder', input: build() },
  ];
  for (const [index, event] of routes.entries()) {
    assert.equal(await mipmux.toolCall({ ...event, toolCallId: `call-${index}` }, ctx), undefined);
    assert.deepEqual('args' in event.input ? event.input.args : event.input, expected, event.toolName);
  }
  const text = { toolName: 'mcp', toolCallId: 'text', input: { tool: 'context_builder', server: 'mipmux', args: JSON.stringify(build()) } };
  await mipmux.toolCall(text, ctx);
  assert.deepEqual(JSON.parse(String(text.input.args)), expected);
  const input: CallArgs = { workspace: structuredClone(appDeclaration), bundle: 'run-1', prompt: 'Final', outputName: 'run-1-final' };
  const nested = { toolName: 'mcp__mipmux__context_prepare', toolCallId: 'parent/1', parentToolCallId: 'parent', input };
  await mipmux.toolCall(nested, ctx);
  assert.equal(nested.input.budgetUnits, 150000);
});

test('a gateway call without arguments receives the preferences as its arguments', async () => {
  const { mipmux, ctx } = await selected({ selected: null, preferences: { budgetUnits: { value: 150000, pinned: false } }, lastDeclared: null });
  const event = { toolName: 'mcp', toolCallId: 'bare', input: { tool: 'mipmux_context_builder' } };
  await mipmux.toolCall(event, ctx);
  assert.deepEqual(event.input, { tool: 'mipmux_context_builder', args: { budgetUnits: 150000 } });
});

test('a gateway call whose argument text is not a JSON object is blocked with the parse problem', async () => {
  const { mipmux, ctx } = await selected();
  for (const args of ['{"workspace":', '[1, 2]']) {
    const blocked = await mipmux.toolCall({ toolName: 'mcp', toolCallId: 'm', input: { tool: 'context_prepare', server: 'mipmux', args } }, ctx);
    assert.ok(blocked);
    assert.match(blocked.reason, /The mipmux context_prepare arguments are not valid JSON/);
  }
});

test('other servers and tools are untouched', async () => {
  const { mipmux, ctx } = await selected();
  for (const event of [
    { toolName: 'mcp', toolCallId: 'n1', input: { tool: 'context_builder', server: 'notion', args: build({ workspace: 'elsewhere' }) } },
    { toolName: 'mcp__notion', toolCallId: 'n2', input: { tool: 'context_builder', args: build({ workspace: 'elsewhere' }) } },
    { toolName: 'mcp__mipmux__context_job', toolCallId: 'n3', input: { op: 'status', jobId: 'job' } },
    { toolName: 'bash', toolCallId: 'n4', input: { command: 'ls' } },
  ]) {
    const before = structuredClone(event.input);
    assert.equal(await mipmux.toolCall(event, ctx), undefined);
    assert.deepEqual(event.input, before, event.toolName);
  }
});

test('a gateway call handed off to the per-tool registration is rewritten once and noted once', async () => {
  const { mipmux, ctx } = await selected({ ...pinnedBudget, preferences: { budgetUnits: { value: 150000, pinned: false } } });
  const args = build();
  await mipmux.toolCall({ toolName: 'mcp', toolCallId: 'outer', input: { tool: 'context_builder', server: 'mipmux', args } }, ctx);
  const child = { toolName: 'mcp__mipmux__context_builder', toolCallId: 'outer/1', parentToolCallId: 'outer', input: args };
  await mipmux.toolCall(child, ctx);
  assert.deepEqual(args, build({ budgetUnits: 150000 }));
  const conflict = { content: [{ type: 'text' as const, text: '{"kind":"error","code":"outputNameConflict"}' }], isError: true };
  assert.equal(mipmux.toolResult({ ...conflict, toolCallId: 'outer/1' }), undefined);
  const noted = mipmux.toolResult({ ...conflict, toolCallId: 'outer' });
  assert.ok(noted); assert.ok(noted.content);
  assert.equal(noted.content.length, 2);
  assert.match(JSON.stringify(noted.content[1]), /use a new outputName or restore the earlier preferences/);
  assert.equal(mipmux.toolResult({ ...conflict, toolCallId: 'outer' }), undefined);
});

test('a call naming another workspace is blocked with the selected declaration', async () => {
  const { mipmux, ctx } = await selected();
  const other = build({ workspace: { ...appDeclaration, outputRoot: '/tmp/out' } });
  const blocked = await mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'b', input: other }, ctx);
  assert.ok(blocked);
  assert.equal(blocked.block, true);
  assert(blocked.reason.includes(JSON.stringify(appDeclaration)));
  assert.equal(other.budgetUnits, undefined);
});

test('the selected declaration reaches the agent as a prompt section', async () => {
  const { mipmux, ctx } = await selected();
  const sections: Record<string, string> = {};
  await mipmux.beforeAgentStart({ systemPromptOptions: { sections } });
  assert.match(sections.mipmux_workspace ?? '', /"app"/);
  assert(sections.mipmux_workspace?.includes(JSON.stringify(appDeclaration)));
  const unselected = await instance();
  const fresh = context();
  await unselected.mipmux.restore(fresh.ctx);
  const none: Record<string, string> = {};
  await unselected.mipmux.beforeAgentStart({ systemPromptOptions: { sections: none } });
  assert.deepEqual(none, {});
});
