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

test('direct and codemode calls are rewritten in place', async () => {
  const { mipmux, ctx } = await selected();
  const direct = { toolName: 'mcp__mipmux__context_builder', toolCallId: 'direct', input: build() };
  assert.deepEqual(await mipmux.toolCall(direct, ctx), { kind: 'allowed', changed: true });
  assert.deepEqual(direct.input, build({ budgetUnits: 150000 }));
  const input: CallArgs = { workspace: structuredClone(appDeclaration), bundle: 'run-1', prompt: 'Final', outputName: 'run-1-final' };
  const nested = { toolName: 'mcp__mipmux__context_prepare', toolCallId: 'parent/1', parentToolCallId: 'parent', input };
  await mipmux.toolCall(nested, ctx);
  assert.equal(nested.input.budgetUnits, 150000);
});

test('other servers and tools are untouched', async () => {
  const { mipmux, ctx } = await selected();
  for (const event of [
    { toolName: 'mcp__notion__context_builder', toolCallId: 'n1', input: build({ workspace: 'elsewhere' }) },
    { toolName: 'mcp__mipmux__context_job', toolCallId: 'n2', input: { op: 'status', jobId: 'job' } },
    { toolName: 'bash', toolCallId: 'n3', input: { command: 'ls' } },
  ]) {
    const before = structuredClone(event.input);
    assert.deepEqual(await mipmux.toolCall(event, ctx), { kind: 'allowed', changed: false });
    assert.deepEqual(event.input, before, event.toolName);
  }
});

test('a conflict on a call the extension changed is noted once, and other conflicts are not', async () => {
  const { mipmux, ctx } = await selected({ ...pinnedBudget, preferences: { budgetUnits: { value: 150000, pinned: false } } });
  await mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'changed', input: build() }, ctx);
  await mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'kept', input: build({ budgetUnits: 150000 }) }, ctx);
  const conflict = { content: [{ type: 'text' as const, text: '{"kind":"error","code":"outputNameConflict"}' }], isError: true };
  assert.equal(mipmux.toolResult({ ...conflict, toolCallId: 'kept' }), undefined);
  const noted = mipmux.toolResult({ ...conflict, toolCallId: 'changed' });
  assert.ok(noted);
  assert.equal(noted.length, 2);
  assert.match(JSON.stringify(noted[1]), /use a new outputName or restore the earlier preferences/);
  assert.equal(mipmux.toolResult({ ...conflict, toolCallId: 'changed' }), undefined);
});

test('a call naming another workspace is blocked with the selected declaration', async () => {
  const { mipmux, ctx } = await selected();
  const other = build({ workspace: { ...appDeclaration, outputRoot: '/tmp/out' } });
  const blocked = await mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'b', input: other }, ctx);
  assert(blocked.kind === 'blocked');
  assert(blocked.reason.includes(JSON.stringify(appDeclaration)));
  assert.equal(other.budgetUnits, undefined);
});

test('the selected declaration reaches the agent as a prompt section', async () => {
  const { mipmux, ctx } = await selected();
  const section = await mipmux.beforeAgentStart(ctx);
  assert.match(section ?? '', /"app"/);
  assert(section?.includes(JSON.stringify(appDeclaration)));
  const unselected = await instance();
  const fresh = context();
  await unselected.mipmux.restore(fresh.ctx);
  assert.equal(await unselected.mipmux.beforeAgentStart(fresh.ctx), null);
});
