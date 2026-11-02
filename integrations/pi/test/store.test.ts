import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readStore, StoreError, updateStore } from '../src/store.ts';
import type { SavedWorkspace } from '../src/state.ts';

const app: SavedWorkspace = { name: 'app', roots: [{ name: 'app', absolutePath: '/repos/app' }], outputRoot: '/repos/app/prompt-exports' };

test('a missing file is an empty list, and an invalid file fails with its path and first problem', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mipmux-store-')), path = join(directory, 'mipmux.json');
  assert.deepEqual(await readStore(path), { workspaces: [], showInFooter: true });
  for (const [content, problem] of [
    ['{"workspaces": [', /not valid JSON/],
    [JSON.stringify({ workspaces: [{ ...app, outputRoot: 'relative' }] }), /\/workspaces\/0\/outputRoot/],
    [JSON.stringify({ workspaces: [app, { ...app, outputRoot: '/other' }] }), /"app" is saved twice/],
    [JSON.stringify({ workspaces: [{ ...app, exclusions: [] }] }), /\/workspaces\/0 must not have additional properties/],
  ] as const) {
    await writeFile(path, content);
    await assert.rejects(readStore(path), error => error instanceof StoreError && error.message.includes(path) && problem.test(error.message));
  }
});

test('updates merge duplicates and replace the file atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mipmux-store-')), path = join(directory, 'mipmux.json');
  const first = await updateStore(path, store => ({ ...store, workspaces: [...store.workspaces, app] }));
  assert.deepEqual(first, { workspaces: [app], showInFooter: true, merges: [] });
  const second = await updateStore(path, store => ({ ...store, workspaces: [...store.workspaces, { ...app, name: 'app-again' }] }));
  assert.deepEqual(second, { workspaces: [app], showInFooter: true, merges: [{ survivor: 'app', removed: [{ name: 'app-again' }] }] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { workspaces: [app], showInFooter: true });
  assert.deepEqual(await readdir(directory), ['mipmux.json']);
});
