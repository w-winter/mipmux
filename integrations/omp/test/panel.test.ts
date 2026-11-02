import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getKeybindings } from '@oh-my-pi/pi-tui';
import type { MipmuxCommands } from '../src/config.ts';
import type { PanelComponent } from '../src/panel.ts';
import { createMipmux, type MipmuxContext } from '../src/register.ts';
import type { SessionState } from '../src/state.ts';

// Keys as a terminal sends them, Ctrl+S with the enhanced keyboard protocol omp turns on.
const key = { down: '\x1b[B', enter: '\r', escape: '\x1b', save: '\x1b[115;5u' };
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const width = 120;

test('the shared panel runs on omp\'s terminal components: a list choice, a typed budget and ctrl+s reach the session', async () => {
  const base = await mkdtemp(join(tmpdir(), 'omp-mipmux-panel-')), storePath = join(base, 'mipmux.json');
  const workspace = { name: 'app', roots: [{ name: 'app', absolutePath: join(base, 'app') }], outputRoot: join(base, 'app', 'prompt-exports') };
  await writeFile(storePath, JSON.stringify({ workspaces: [workspace] }));
  const mipmux: MipmuxCommands = {
    config: async () => ({ kind: 'config', path: join(base, 'config.json'), contextBudgetUnits: 200000, defaultEnhancementMode: 'augment',
      tools: 'core', discovery: null }),
    models: async () => [],
  };
  const appended: SessionState[] = [], components: PanelComponent[] = [];
  const extension = createMipmux({ storePath, home: base, appendEntry: state => { appended.push(state); }, mipmux });
  const ctx: MipmuxContext = { hasUI: true, mode: 'tui', cwd: base, sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {}, notify: () => {},
      custom: factory => new Promise(resolve => { components.push(factory({ requestRender: () => {} }, plain, getKeybindings(), () => resolve())); }) } };

  const closed = extension.command('', ctx);
  while (components.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const panel = components[0] ?? assert.fail('the panel did not open');
  const press = async (...keys: string[]) => { for (const data of keys) await panel.handleInput(data); };
  const highlighted = () => panel.render(width).find(line => line.startsWith('→ ')) ?? '';

  await press(key.enter, key.enter);
  assert.match(highlighted(), /Selected workspace\s+app/);
  while (!/Budget/.test(highlighted())) await press(key.down);
  await press(key.enter, ...'150k', key.enter, key.save, key.escape);
  await closed;

  assert.deepEqual(appended.at(-1), { selected: 'app', preferences: { budgetUnits: { value: 150000, pinned: false } }, lastDeclared: null });
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).workspaces, [workspace], 'choosing a workspace leaves the saved file as it was');
});
