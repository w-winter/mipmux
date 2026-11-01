import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { appDeclaration, context, instance, stateEntry } from './fixtures.ts';
import { emptyState, type SessionState } from '../src/state.ts';

const first: SessionState = { selected: 'app', preferences: { budgetUnits: { value: 1000, pinned: false } }, lastDeclared: null };
const last: SessionState = { selected: null, preferences: { enhancementMode: { value: 'preserve', pinned: true } }, lastDeclared: appDeclaration };

test('state is rebuilt from the last mipmux entry on the branch, and an empty branch starts empty', async () => {
  const { mipmux } = await instance();
  const other = { type: 'custom' as const, customType: 'tools-config', data: { enabledTools: [] }, id: 'x', parentId: null,
    timestamp: '2026-11-01T00:00:00.000Z' };
  const restored = context([stateEntry(first, 'e1'), stateEntry(last, 'e2'), other]);
  await mipmux.restore(restored.ctx);
  assert.deepEqual(mipmux.state(), last);
  assert.deepEqual(restored.statuses, ['mipmux: no workspace']);
  const empty = context();
  await mipmux.restore(empty.ctx);
  assert.deepEqual(mipmux.state(), emptyState);
});

test('selecting by name records the state and shows it, and an unknown name changes nothing', async () => {
  const { mipmux, appended, storePath } = await instance();
  const session = context();
  await mipmux.restore(session.ctx);
  await mipmux.command('app', session.ctx);
  assert.deepEqual(appended, [{ ...emptyState, selected: 'app' }]);
  assert.equal(session.statuses.at(-1), 'mipmux: app');
  await mipmux.command('nope', session.ctx);
  assert.equal(appended.length, 1);
  assert.match(session.notices.at(-1) ?? '', /No saved workspace named "nope".*app/);
  assert.deepEqual(await mipmux.completions('a'), [{ value: 'app', label: 'app' }]);
  // A selection that disappears from the file, or a file that cannot be read, shows in the status line.
  await writeFile(storePath, JSON.stringify({ workspaces: [] }));
  await mipmux.restore(context([stateEntry({ ...emptyState, selected: 'app' }, 'e1')]).ctx);
  const missing = context([stateEntry({ ...emptyState, selected: 'app' }, 'e1')]);
  await mipmux.restore(missing.ctx);
  assert.deepEqual(missing.statuses, ['mipmux: app (missing)']);
  await writeFile(storePath, '{');
  const broken = context([stateEntry({ ...emptyState, selected: 'app' }, 'e1')]);
  await mipmux.restore(broken.ctx);
  assert.deepEqual(broken.statuses, ['mipmux: app (file error)']);
});

test('without a UI, /mipmux reports the effective state as text', async () => {
  const { mipmux } = await instance();
  const session = context([stateEntry(first, 'e1')], false);
  await mipmux.restore(session.ctx);
  await mipmux.command('', session.ctx);
  const report = session.notices.at(-1) ?? '';
  assert.match(report, /workspace: app/); assert.match(report, /budget: 1000 units \(session\)/);
  assert.match(report, /discovery model: server default/);
});
