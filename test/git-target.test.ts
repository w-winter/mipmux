import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { SourceSelection } from '../src/contracts/context.js';
import { SmipRuntime } from '../src/runtime/smip-runtime.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const signal = () => new AbortController().signal;

test('scout implicit Git uses frozen selected-file ownership rather than all loaded roots', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-git-target-'));
  const outer = join(base, 'aaa'), nested = join(outer, 'zzz'), plain = join(base, 'plain'), out = join(base, 'out');
  await mkdir(nested, { recursive: true }); await mkdir(plain); await mkdir(out);
  const run = (cwd: string, args: string[]) => execFileSync(git, args, { cwd, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const initialize = (cwd: string) => {
    run(cwd, ['init', '-q']); run(cwd, ['config', 'user.name', 'Fixture']); run(cwd, ['config', 'user.email', 'fixture@example.invalid']);
    run(cwd, ['add', '.']); run(cwd, ['commit', '-qm', 'base']);
  };
  await writeFile(join(outer, 'file.txt'), 'outer base\n'); await writeFile(join(nested, 'file.txt'), 'nested base\n');
  await writeFile(join(plain, 'file.txt'), 'plain evidence\n');
  await writeFile(join(nested, 'types.swift'), 'struct SelectedType { let value: Int }\n');
  initialize(outer); initialize(nested);
  await writeFile(join(outer, 'file.txt'), 'OUTER_CHANGE\n'); await writeFile(join(nested, 'file.txt'), 'NESTED_CHANGE\n');
  const scenarios: { name: string; sources: SourceSelection[]; expected: 'nested' | 'outer' | 'restricted' | 'changed' }[] = [
    { name: 'nested-file', sources: [{ kind: 'full', source: { root: 'r', path: 'zzz/file.txt' } }], expected: 'nested' },
    { name: 'nested-slice', sources: [{ kind: 'slices', source: { root: 'r', path: 'zzz/file.txt' },
      ranges: [{ start: 1, end: 1, description: 'Selected nested implementation' }] }], expected: 'nested' },
    { name: 'outer-primary', sources: [{ kind: 'full', source: { root: 'r', path: 'zzz/file.txt' } },
      { kind: 'full', source: { root: 'r', path: 'file.txt' } }], expected: 'outer' },
    { name: 'empty', sources: [], expected: 'restricted' },
    { name: 'codemap-only', sources: [{ kind: 'codemap', source: { root: 'r', path: 'zzz/types.swift' } }], expected: 'restricted' },
    { name: 'mixed-non-git', sources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } },
      { kind: 'full', source: { root: 'plain', path: 'file.txt' } }], expected: 'restricted' },
    { name: 'removed-checkout', sources: [{ kind: 'full', source: { root: 'r', path: 'zzz/file.txt' } },
      { kind: 'full', source: { root: 'r', path: 'file.txt' } }], expected: 'changed' },
  ];
  const proof: unknown[] = [];
  for (const scenario of scenarios) {
    const provider = await scriptedProvider((_summary, index) => {
      if (scenario.expected === 'changed' && index === 1) return { kind: 'tool', name: 'manage_selection',
        input: { op: 'remove', paths: ['zzz/file.txt'], expectedRevision: 0, maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 };
      const diffIndex = scenario.expected === 'changed' ? 2 : 1;
      if (index === diffIndex) {
        if (scenario.expected === 'changed') renameSync(join(nested, '.git'), join(base, 'retired-nested-git'));
        return { kind: 'tool', name: 'git', input: { op: 'diff', detail: 'full', maxOutputBytes: 100000 }, stop: 'tool_use', tokens: 10 };
      }
      return { kind: 'text', text: 'complete', stop: 'end_turn', tokens: 10 };
    });
    const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache-' + scenario.name), contextBudgetUnits: 200000,
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {},
      credentialPaths: [], terminationGraceMs: 100, git: { executable: git } });
    const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor, (operation, signal) => runtime.renderPresentation(operation, signal)));
    try {
      const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: outer }, { name: 'plain', absolutePath: plain }],
        exclusions: [], outputRoot: out }, signal());
      const job = client.build(workspace.id, scenario.name, { task: 'Inspect the selected checkout', constraints: '',
        purpose: 'review', enhancementMode: 'preserve', initialSelection: { codemapMode: 'manual', sources: scenario.sources },
        duplicateUserInstructionsAtTop: false, copyPreset: 'standard', requiredSources: [],
        documents: [], patches: [], discoveryHints: [], budgetUnits: 200000, outputName: scenario.name });
      const terminal = await client.wait(job.jobId, 10000, signal(), () => {});
      assert.equal(terminal.state, 'ready', JSON.stringify(terminal)); assert.equal(terminal.localSettled, true);
      const returned = JSON.stringify(provider.requests.at(-1)?.messages);
      assert(!returned.includes('Invalid arguments'), returned);
      if (scenario.expected === 'restricted') assert(returned.includes('gitTargetRequired'), returned);
      else if (scenario.expected === 'changed') assert(returned.includes('gitRepositoryChanged'), returned);
      else {
        assert(returned.includes('NESTED_CHANGE'), returned);
        assert.equal(returned.includes('OUTER_CHANGE'), scenario.expected === 'outer', returned);
      }
      proof.push({ name: scenario.name, terminal, messages: provider.requests.at(-1)?.messages });
    } finally {
      await runtime.close(); await provider.close();
      if (scenario.expected === 'changed') renameSync(join(base, 'retired-nested-git'), join(nested, '.git'));
    }
  }
  await writeFile('test-output/git-target-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
