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
// Ctrl+S as a terminal sends it with Pi's enhanced keyboard protocol active, and as the legacy control byte otherwise.
const key = { up: '\x1b[A', down: '\x1b[B', enter: '\r', escape: '\x1b', tab: '\t', save: '\x1b[115;5u', legacySave: '\x13', clearLine: '\x15',
  delete: '\x1b[3~' };
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
  const components: PanelComponent[] = [];
  const ctx: MipmuxContext = { hasUI: true, mode: 'tui', cwd, sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {}, notify: message => { notices.push(message); },
      custom: factory => new Promise(resolve => { components.push(factory({ requestRender: () => {} }, plain, getKeybindings(), () => resolve())); }) } };
  return { home, storePath, appended, notices, mipmux, ctx, components };
}

/** Opens /mipmux and returns a driver that presses keys in order, waiting for each to take effect. */
async function panel(fixture: Awaited<ReturnType<typeof setup>>) {
  const count = fixture.components.length, closed = fixture.mipmux.command('', fixture.ctx);
  while (fixture.components.length === count) await new Promise(resolve => setTimeout(resolve, 5));
  const component = fixture.components[count] ?? assert.fail('the panel did not open');
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
    outputRoot: '/elsewhere/other/prompt-exports' };
  const fixture = await setup([taken]);
  const { press, focus, closed, screen } = await panel(fixture);
  await focus('Roots');
  await press(key.enter, key.clearLine, ...'~/proj', key.tab);
  assert.match(screen(), /~\/Projects\//, 'Tab completes the folder name whatever its case');
  await press(...'ALPHA-A', key.tab, key.enter);
  await press(key.enter, key.down, key.enter, ...'bet', key.enter, key.escape);
  await focus('Discovery model');
  await press(key.enter);
  assert.match(screen(), /discovery\.allowedModels in\s+\/home\/user\/\.config\/mipmux\/config\.json/, 'the model list names the file to edit');
  await press(key.escape);
  await focus('Budget');
  await press(key.enter, key.clearLine, ...'150k', key.enter, 'p');
  assert.match(screen(), /unsaved/);
  await press(key.save, key.escape);
  await closed;

  const project = join(fixture.home, 'Projects');
  const created: SavedWorkspace = { name: 'alpha-app (1)', roots: [{ name: 'alpha-app', absolutePath: join(project, 'alpha-app') },
    { name: 'beta', absolutePath: join(project, 'beta') }], outputRoot: join(project, 'alpha-app', 'prompt-exports') };
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

test('ignore rules and a rename are saved with ctrl+s, escape discards the rest, and a hand edit is never overwritten', async () => {
  const fixture = await setup();
  const app = join(fixture.home, 'Projects', 'alpha-app'), ignoreFile = join(app, '.mipmux_ignore');
  await mkdir(join(app, 'docs', 'investigations'), { recursive: true });
  await writeFile(ignoreFile, '# notes\n*.tmp\n');
  const saved: SavedWorkspace = { name: 'alpha-app', roots: [{ name: 'alpha-app', absolutePath: app }], outputRoot: join(app, 'prompt-exports') };
  await writeFile(fixture.storePath, JSON.stringify({ workspaces: [saved] }));
  await fixture.mipmux.command('alpha-app', fixture.ctx);
  const first = await panel(fixture);
  await first.focus('Ignore rules');
  await first.press(key.enter, key.delete, key.enter, ...'node_m', key.tab, key.enter);
  await first.press(key.enter, ...'!docs/inv', key.tab, key.enter);
  await first.press(key.enter, ...'**/*.log', key.enter);
  await first.press(key.enter, ...'#x', key.enter);
  assert.match(first.screen(), /comment/);
  await first.press(key.escape, key.escape);
  await first.focus('Rename');
  await first.press(key.enter, key.clearLine, ...'frontend', key.enter, key.legacySave);
  await first.focus('Budget');
  await first.press(key.enter, key.clearLine, ...'5000', key.enter, key.escape);
  await first.closed;

  assert.equal(await readFile(ignoreFile, 'utf8'), '# notes\n/node_modules/\n!docs/investigations/\n**/*.log\n');
  assert.deepEqual(await savedStore(fixture.storePath), [{ ...saved, name: 'frontend' }]);
  assert.deepEqual(fixture.mipmux.state(), { selected: 'frontend', preferences: {}, lastDeclared: null });
  assert.match(fixture.notices.at(-1) ?? '', /discarded/);

  const second = await panel(fixture);
  await second.focus('Ignore rules');
  await second.press(key.enter);
  await second.focus('+ Add a rule');
  await second.press(key.enter, ...'notes.md', key.enter);
  await writeFile(ignoreFile, 'hand\n');
  await second.press(key.save);
  assert.match(second.screen(), /changed\s+while the panel was open/);
  await second.press(key.escape, key.escape);
  await second.closed;
  assert.equal(await readFile(ignoreFile, 'utf8'), 'hand\n');
});
