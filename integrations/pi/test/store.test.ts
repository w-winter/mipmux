import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readStore, StoreError, updateStore } from '../src/store.ts';
import type { SavedWorkspace } from '../src/state.ts';

const app: SavedWorkspace = { name: 'app', roots: [{ name: 'app', absolutePath: '/repos/app' }], outputRoot: '/repos/app/prompt-exports', exclusions: [] };

test('a missing file is an empty list, and an invalid file fails with its path and first problem', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mipmux-store-')), path = join(directory, 'mipmux.json');
  assert.deepEqual(await readStore(path), []);
  for (const [content, problem] of [
    ['{"workspaces": [', /not valid JSON/],
    [JSON.stringify({ workspaces: [{ ...app, outputRoot: 'relative' }] }), /\/workspaces\/0\/outputRoot/],
    [JSON.stringify({ workspaces: [app, { ...app, outputRoot: '/other' }] }), /"app" is saved twice/],
    [JSON.stringify({ workspaces: [{ ...app, exclusions: [{ kind: 'prefix', root: 'missing', path: 'x' }] }] }), /root "missing"/],
  ] as const) {
    await writeFile(path, content);
    await assert.rejects(readStore(path), error => error instanceof StoreError && error.message.includes(path) && problem.test(error.message));
  }
});

test('updates merge duplicates and replace the file atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mipmux-store-')), path = join(directory, 'mipmux.json');
  const first = await updateStore(path, workspaces => [...workspaces, app]);
  assert.deepEqual(first, { workspaces: [app], merges: [] });
  const second = await updateStore(path, workspaces => [...workspaces, { ...app, name: 'app-again' }]);
  assert.deepEqual(second, { workspaces: [app], merges: [{ survivor: 'app', removed: [{ name: 'app-again' }] }] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { workspaces: [app] });
  assert.deepEqual(await readdir(directory), ['mipmux.json']);
});
