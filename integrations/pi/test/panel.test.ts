import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getKeybindings } from '@earendil-works/pi-tui';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { createMipmux, type MipmuxContext } from '../src/register.ts';
import type { MipmuxCommands } from '../src/config.ts';
import type { PanelComponent } from '../src/panel.ts';
import { EnhancementMode, ThinkingLevel, type CallArgs, type SavedWorkspace, type SessionState } from '../src/state.ts';

const configFile = { contextBudgetUnits: 200000, cachePath: '/cache',
  discovery: { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'medium', allowedModels: ['anthropic/claude-haiku-4-5'], modelsPath: '/models.json' } };
const ConfigFile = Compile(Type.Object({ contextBudgetUnits: Type.Optional(Type.Integer({ minimum: 1 })), defaultEnhancementMode: Type.Optional(EnhancementMode),
  discovery: Type.Optional(Type.Object({ provider: Type.String(), model: Type.String(), thinking: ThinkingLevel,
    allowedModels: Type.Optional(Type.Array(Type.String())) })) }));
const credentialedModels = ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5-5', 'openai-codex/gpt-6.1-sol'];

/** Stands in for mipmux: reports a configuration file as `mipmux config` resolves it, and rejects one mipmux would reject. */
function fakeMipmux(defaultPath: string): MipmuxCommands {
  return {
    async config(path = defaultPath) {
      const file: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!ConfigFile.Check(file)) throw new Error(`mipmux config failed: {"kind":"failed","code":"invalidConfiguration"}`);
      const discovery = file.discovery;
      return { kind: 'config', path, contextBudgetUnits: file.contextBudgetUnits ?? 200000, defaultEnhancementMode: file.defaultEnhancementMode ?? 'augment',
        tools: 'core', discovery: discovery ? { model: `${discovery.provider}/${discovery.model}`, thinking: discovery.thinking,
          allowedModels: discovery.allowedModels ?? [] } : null };
    },
    models: async () => credentialedModels,
  };
}
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
  const storePath = join(base, 'mipmux.json'), configPath = join(base, 'config.json');
  await writeFile(storePath, JSON.stringify({ workspaces: saved }));
  await writeFile(configPath, JSON.stringify(configFile, null, 4) + '\n');
  const appended: SessionState[] = [], notices: string[] = [], statuses: (string | undefined)[] = [];
  const mipmux = createMipmux({ storePath, home, appendEntry: state => { appended.push(state); }, mipmux: fakeMipmux(configPath) });
  const components: PanelComponent[] = [];
  const ctx: MipmuxContext = { hasUI: true, mode: 'tui', cwd, sessionManager: { getBranch: () => [] },
    ui: { setStatus: (_key, text) => { statuses.push(text); }, notify: message => { notices.push(message); },
      custom: factory => new Promise(resolve => { components.push(factory({ requestRender: () => {} }, plain, getKeybindings(), () => resolve())); }) } };
  return { home, storePath, configPath, appended, notices, statuses, mipmux, ctx, components };
}

/** Opens /mipmux and returns a driver that presses keys in order, waiting for each to take effect. */
async function panel(fixture: Awaited<ReturnType<typeof setup>>) {
  const count = fixture.components.length, closed = fixture.mipmux.command('', fixture.ctx);
  while (fixture.components.length === count) await new Promise(resolve => setTimeout(resolve, 5));
  const component = fixture.components[count] ?? assert.fail('the panel did not open');
  const press = async (...keys: string[]) => { for (const data of keys) await component.handleInput(data); };
  /** Moves the cursor down to the first row whose text contains `label`, or matches it. */
  const focus = async (label: string | RegExp) => {
    const pattern = label instanceof RegExp ? label : new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    for (let step = 0; step < 30; step++) {
      if (pattern.test(component.render(width).find(line => line.startsWith('→ ')) ?? '')) return;
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
  assert.match(screen(), /anthropic\/claude-haiku-4-5/);
  assert.match(screen(), /Allowed models/, 'the model list says where to allow another model');
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
  assert.deepEqual(await fixture.mipmux.toolCall({ toolName: 'mcp__mipmux__context_builder', toolCallId: 'c1', input: args }, fixture.ctx),
    { kind: 'allowed', changed: true });
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

test('server defaults are written into the configuration file, keeping its other keys, and a file edited meanwhile is never overwritten', async () => {
  const fixture = await setup();
  const { press, focus, closed, screen } = await panel(fixture);
  await focus('Allowed models');
  await press(key.enter, ...'sonn', key.enter, key.escape);
  await focus(/Thinking level\s+medium/);
  await press(key.enter, key.up, key.enter);
  await focus(/Budget\s+200,000 units/);
  await press(key.enter, key.clearLine, ...'150k', key.enter, key.save);
  const text = await readFile(fixture.configPath, 'utf8');
  assert.deepEqual(JSON.parse(text), { ...configFile, contextBudgetUnits: 150000, discovery: { ...configFile.discovery, thinking: 'low',
    allowedModels: ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5-5'] } });
  assert.deepEqual(Object.keys(JSON.parse(text)), Object.keys(configFile));
  assert.match(text, /^\{\n {4}"contextBudgetUnits"/);
  // Sessions may now choose the newly allowed model.
  await focus('Discovery model');
  await press(key.enter);
  assert.match(screen(), /anthropic\/claude-sonnet-5-5/);
  await press(key.escape);

  await writeFile(fixture.configPath, text.replace('150000', '160000'));
  await focus(/Budget\s+150,000 units/);
  await press(key.enter, key.clearLine, ...'90000', key.enter, key.save);
  assert.match(screen(), /changed\s+while the panel was open/);
  assert.equal(JSON.parse(await readFile(fixture.configPath, 'utf8')).contextBudgetUnits, 160000);
  await press(key.escape);
  await closed;
});

test('the last panel row hides the footer item in every session, and escape leaves it as it was', async () => {
  const fixture = await setup([{ name: 'alpha', roots: [{ name: 'alpha', absolutePath: '/repos/alpha' }], outputRoot: '/repos/alpha/prompt-exports' }]);
  await fixture.mipmux.command('alpha', fixture.ctx);
  // Another Pi session of the same user, sharing the saved-workspace file.
  const otherStatuses: (string | undefined)[] = [];
  const other = createMipmux({ storePath: fixture.storePath, home: fixture.home, appendEntry: () => {}, mipmux: fakeMipmux(fixture.configPath) });
  const otherCtx: MipmuxContext = { ...fixture.ctx, ui: { ...fixture.ctx.ui, setStatus: (_key, text) => { otherStatuses.push(text); } } };
  await other.restore(otherCtx);
  assert.deepEqual([fixture.statuses.at(-1), otherStatuses.at(-1)], ['mipmux: alpha', 'mipmux: no workspace']);
  const showInFooter = async () => JSON.parse(await readFile(fixture.storePath, 'utf8')).showInFooter;

  const first = await panel(fixture);
  await first.press(key.up);
  assert.match(first.screen(), /→ Show in footer\s+on/, 'the footer row is the last row');
  await first.press(key.enter, key.escape);
  await first.closed;
  assert.equal(fixture.statuses.at(-1), 'mipmux: alpha');
  assert.equal(await showInFooter(), undefined);

  const second = await panel(fixture);
  await second.press(key.up, key.enter, key.save);
  assert.equal(fixture.statuses.at(-1), undefined);
  assert.equal(await showInFooter(), false);
  await other.beforeAgentStart(otherCtx);
  assert.equal(otherStatuses.at(-1), undefined, 'an open session hides it before its next prompt');
  await second.press(key.enter, key.save, key.escape);
  await second.closed;
  assert.equal(fixture.statuses.at(-1), 'mipmux: alpha');
  assert.equal(await showInFooter(), true);
});
