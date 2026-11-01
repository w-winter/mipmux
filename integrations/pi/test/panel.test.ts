import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createMipmux, type MipmuxContext } from '../src/register.ts';
import type { MipmuxConfig } from '../src/config.ts';
import type { SessionState } from '../src/state.ts';

const config: MipmuxConfig = { kind: 'config', path: '/home/user/.config/mipmux/config.json', contextBudgetUnits: 200000,
  defaultEnhancementMode: 'augment', tools: 'core',
  discovery: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium', allowedModels: ['anthropic/claude-haiku-4-5'] } };

/** One scripted answer per dialog, in the order the panel asks. */
type Answer = { readonly dialog: 'select'; choose(options: readonly string[]): string | undefined } |
  { readonly dialog: 'input'; readonly text: string } | { readonly dialog: 'confirm'; readonly accept: boolean };
const option = (label: string): Answer => ({ dialog: 'select', choose: options => options.find(entry => entry === label) });
const startingWith = (prefix: string): Answer => ({ dialog: 'select', choose: options => options.find(entry => entry.startsWith(prefix)) });
const typed = (text: string): Answer => ({ dialog: 'input', text });
const confirmed: Answer = { dialog: 'confirm', accept: true };

function scripted(cwd: string, answers: Answer[]): MipmuxContext {
  const next = <D extends Answer['dialog']>(dialog: D): Extract<Answer, { dialog: D }> => {
    const answer = answers.shift();
    assert(answer?.dialog === dialog, `the panel opened a ${dialog} dialog where the script expected ${answer?.dialog ?? 'nothing'}`);
    // SAFETY: the assertion above established that the answer's dialog is `dialog`.
    return answer as Extract<Answer, { dialog: D }>;
  };
  return { hasUI: true, cwd, sessionManager: { getBranch: () => [] },
    ui: { setStatus: () => {}, notify: () => {},
      select: async (_title, options) => {
        const choice = next('select').choose(options);
        assert(choice !== undefined, `no scripted choice among ${options.join(' | ')}`);
        return choice;
      },
      input: async () => next('input').text,
      confirm: async () => next('confirm').accept } };
}

test('the panel creates and selects a saved workspace, then sets and pins a session budget', async () => {
  const base = await mkdtemp(join(tmpdir(), 'pi-mipmux-panel-')), storePath = join(base, 'mipmux.json');
  const appended: SessionState[] = [];
  const mipmux = createMipmux({ storePath, appendEntry: state => { appended.push(state); }, readConfig: async () => config });
  const root = join(base, 'project'), output = join(root, 'prompt-exports');
  await mkdir(root);
  const ctx = scripted(root, [
    startingWith('workspace:'), option('create a saved workspace'), option('continue'), option(output), option('continue'), typed(''), confirmed,
    startingWith('budget:'), option('set for this session'), typed('150000'),
    startingWith('budget:'), option('pin the value for this session'),
    option('close')]);
  await mipmux.command('', ctx);
  const saved = JSON.parse(await readFile(storePath, 'utf8'));
  assert.deepEqual(saved, { workspaces: [{ name: basename(root), roots: [{ name: basename(root), absolutePath: root }], outputRoot: output,
    exclusions: [] }] });
  assert((await stat(output)).isDirectory());
  assert.deepEqual(mipmux.state(), { selected: basename(root), preferences: { budgetUnits: { value: 150000, pinned: true } }, lastDeclared: null });
  assert.deepEqual(appended.at(-1), mipmux.state());
});
