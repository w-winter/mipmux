import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duplicateKey, mergeDuplicates, type SavedWorkspace } from '../src/state.ts';

const app: SavedWorkspace = { name: 'app', roots: [{ name: 'app', absolutePath: '/repos/app' }, { name: 'lib', absolutePath: '/repos/lib' }],
  outputRoot: '/repos/app/prompt-exports', model: { value: 'anthropic/claude-haiku-4-5', pinned: false } };

test('the duplicate key ignores root order, root names and preferences', () => {
  const renamed: SavedWorkspace = { name: 'other', roots: [{ name: 'library', absolutePath: '/repos/lib' }, { name: 'main', absolutePath: '/repos/app' }],
    outputRoot: '/repos/app/prompt-exports', thinking: { value: 'high', pinned: true } };
  assert.equal(duplicateKey(renamed), duplicateKey(app));
  assert.notEqual(duplicateKey({ ...app, roots: app.roots.slice(0, 1) }), duplicateKey(app));
  assert.notEqual(duplicateKey({ ...app, outputRoot: '/repos/app/exports' }), duplicateKey(app));
});

test('merging keeps the earlier entry with its name and model, and reports what the removed entries carried', () => {
  const docs: SavedWorkspace = { name: 'docs', roots: [{ name: 'docs', absolutePath: '/repos/docs' }], outputRoot: '/repos/docs/out' };
  const later: SavedWorkspace = { ...app, name: 'app-copy', roots: [...app.roots].reverse(), model: { value: 'openai/gpt-x', pinned: true },
    thinking: { value: 'low', pinned: false } };
  const { model: _model, ...plain } = { ...app, name: 'app-plain' };
  const merged = mergeDuplicates([app, docs, later, plain]);
  assert.deepEqual(merged.workspaces, [app, docs]);
  assert.deepEqual(merged.merges, [{ survivor: 'app', removed: [
    { name: 'app-copy', droppedModel: { value: 'openai/gpt-x', pinned: true }, droppedThinking: { value: 'low', pinned: false } },
    { name: 'app-plain' }] }]);
  assert.deepEqual(mergeDuplicates([app, docs]), { workspaces: [app, docs], merges: [] });
});
