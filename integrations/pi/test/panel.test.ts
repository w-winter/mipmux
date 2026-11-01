import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getKeybindings } from '@earendil-works/pi-tui';
import { createMipmux, type MipmuxContext } from '../src/register.ts';
import type { MipmuxConfig } from '../src/config.ts';
import type { PanelComponent } from '../src/panel.ts';
import type { CallArgs, SavedWorkspace, SessionState } from '../src/state.ts';

const config: MipmuxConfig = { kind: 'config', path: '/home/user/.config/mipmux/config.json', contextBudgetUnits: 200000,
  defaultEnhancementMode: 'augment', tools: 'core',
  discovery: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium', allowedModels: ['anthropic/claude-haiku-4-5'] } };
const key = { up: '\x1b[A', down: '\x1b[B', enter: '\r', escape: '\x1b', tab: '\t', save: '\x13', clearLine: '\x15', delete: '\x1b[3~' };
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const width = 120;

/** A home folder with projects, an unrelated session directory, and an extension instance whose store holds `saved`. */
async function setup(saved: SavedWorkspace[] = []) {
  const base = await mkdtemp(join(tmpdir(), 'pi-mipmux-panel-')), home = join(base, 'home'), cwd = join(base, 'elsewhere');
  for (const folder of ['Projects/alpha-app/node_modules', 'Projects/alpha-lib', 'Projects/beta']) await mkdir(join(home, folder), { recursive: true });
  await mkdir(cwd);
  const storePath = join(base, 'mipmux.json');
  await writeFile(storePath, JSON.stringify({ workspaces: saved }));
  const appended: SessionState[] = [], notices: string[] = [];
  const mipmux = createMipmux({ storePath, home, appendEntry: state => { appended.push(state); }, readConfig: async () => config });
  let open: (component: PanelComponent) => void = () => {};
  const opened = new Promise<PanelComponent>(resolve => { open = resolve; });
  const ctx: MipmuxContext = { hasUI: true, mode: 'tui', cwd, sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {}, notify: message => { notices.push(message); },
      custom: factory => new Promise(resolve => { open(factory({ requestRender: () => {} }, plain, getKeybindings(), () => resolve())); }) } };
  return { home, storePath, appended, notices, mipmux, ctx, opened };
}

/** Opens /mipmux and returns a driver that presses keys in order, waiting for each to take effect. */
async function panel(fixture: Awaited<ReturnType<typeof setup>>) {
  const closed = fixture.mipmux.command('', fixture.ctx);
  const component = await fixture.opened;
  const press = async (...keys: string[]) => { for (const data of keys) await component.handleInput(data); };
  /** Moves the cursor down to the first row whose text contains `label`. */
  const focus = async (label: string) => {
    for (let step = 0; step < 30; step++) {
      if (component.render(width).find(line => line.startsWith('→ '))?.includes(label)) return;
      await press(key.down);
    }
    assert.fail(`no row containing "${label}" in:\n${component.render(width).join('\n')}`);
  };
  return { press, focus, closed, screen: () => component.render(width).join('\n') };
}

const savedStore = async (path: string): Promise<SavedWorkspace[]> => JSON.parse(await readFile(path, 'utf8')).workspaces;

test('a folder typed with ~ and Tab completion becomes a saved workspace named after it, and ctrl+s applies the choices to the next call', async () => {
  const taken: SavedWorkspace = { name: 'alpha-app', roots: [{ name: 'other', absolutePath: '/elsewhere/other' }],
    outputRoot: '/elsewhere/other/prompt-exports', exclusions: [] };
  const fixture = await setup([taken]);
  const { press, focus, closed, screen } = await panel(fixture);
  await focus('Roots');
  await press(key.enter, key.clearLine, ...'~/proj', key.tab);
  assert.match(screen(), /~\/Projects\//, 'Tab completes the folder name whatever its case');
  await press(...'ALPHA-A', key.tab, key.enter);
  await press(key.enter, key.down, key.enter, ...'bet', key.enter, key.escape);
  await focus('Budget');
  await press(key.enter, key.clearLine, ...'150k', key.enter, 'p');
  assert.match(screen(), /unsaved/);
  await press(key.save, key.escape);
  await closed;

  const project = join(fixture.home, 'Projects');
  const created: SavedWorkspace = { name: 'alpha-app (1)', roots: [{ name: 'alpha-app', absolutePath: join(project, 'alpha-app') },
    { name: 'beta', absolutePath: join(project, 'beta') }], outputRoot: join(project, 'alpha-app', 'prompt-exports'), exclusions: [] };
  assert.deepEqual(await savedStore(fixture.storePath), [taken, created]);
  assert((await stat(created.outputRoot)).isDirectory());
  const state = { selected: 'alpha-app (1)', preferences: { budgetUnits: { value: 150000, pinned: true } }, lastDeclared: null };
  assert.deepEqual(fixture.mipmux.state(), state);
  assert.deepEqual(fixture.appended, [state]);

  const args: CallArgs = { workspace: { roots: created.roots, outputRoot: created.outputRoot, exclusions: [] }, purpose: 'planning',
    task: 'Plan', outputName: 'run-1', budgetUnits: 90000 };
  assert.equal(await fixture.mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'c1', input: args }, fixture.ctx), undefined);
  assert.equal(args.budgetUnits, 150000);
});

test('renaming and exclusions are saved with ctrl+s, and escape discards what was not saved', async () => {
  const fixture = await setup();
  const app = join(fixture.home, 'Projects', 'alpha-app');
  const saved: SavedWorkspace = { name: 'alpha-app', roots: [{ name: 'alpha-app', absolutePath: app }], outputRoot: join(app, 'prompt-exports'),
    exclusions: [] };
  await writeFile(fixture.storePath, JSON.stringify({ workspaces: [saved] }));
  await fixture.mipmux.command('alpha-app', fixture.ctx);
  const first = await panel(fixture);
  await first.focus('Exclusions');
  await first.press(key.enter, key.enter, ...'node_m', key.tab, key.enter);
  await first.press(key.enter, ...'**/*.log', key.enter, key.escape);
  await first.focus('Rename');
  await first.press(key.enter, key.clearLine, ...'frontend', key.enter, key.save);
  await first.focus('Budget');
  await first.press(key.enter, key.clearLine, ...'5000', key.enter, key.escape);
  await first.closed;

  assert.deepEqual(await savedStore(fixture.storePath), [{ ...saved, name: 'frontend', exclusions: [
    { kind: 'prefix', root: 'alpha-app', path: 'node_modules' }, { kind: 'glob', root: 'alpha-app', pattern: '**/*.log' }] }]);
  assert.deepEqual(fixture.mipmux.state(), { selected: 'frontend', preferences: {}, lastDeclared: null });
  assert.match(fixture.notices.at(-1) ?? '', /discarded/);
});
