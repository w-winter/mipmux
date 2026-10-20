import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, type ContextBuildRequest } from '../src/index.js';
import { readValidator, searchValidator, treeValidator } from '../src/contracts/exploration.js';
import { copyContext } from './fixtures/copy-context.js';

const signal = () => new AbortController().signal;
const body = 'struct Hidden { let value: Int }\nsecond line\n';
const request: ContextBuildRequest = { task: 'Inspect explicit evidence', constraints: '', purpose: 'investigation',
  enhancementMode: 'preserve', initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [], documents: [],
  patches: [], duplicateUserInstructionsAtTop: false, copyPreset: 'standard', budgetUnits: 200000,
  discoveryHints: [], outputName: 'packet' };

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'smip-exact-acquisition-')), root = join(base, 'root'), output = join(base, 'out');
  await mkdir(join(root, 'private'), { recursive: true }); await mkdir(join(root, 'cursor')); await mkdir(output);
  await writeFile(join(root, '.repo_ignore'), 'private/\n'); await writeFile(join(root, '.cursorignore'), 'cursor/\n');
  for (const path of ['private/Hidden.swift', 'cursor/Hidden.swift', 'private/Excluded.swift', 'private/Credential.swift']) {
    await writeFile(join(root, path), body);
  }
  await symlink(join(root, 'private/Hidden.swift'), join(root, 'private/Link.swift'));
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000,
    credentialPaths: [join(root, 'private/Credential.swift')], nativeEnvironment: {}, terminationGraceMs: 100,
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`) });
  const client = runtime.createClient(null);
  const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], outputRoot: output,
    exclusions: [{ kind: 'prefix', root: 'r', path: 'private/Excluded.swift' }] }, signal());
  return { base, runtime, client, workspace };
}

test('public exact reads acquire ignored files without selection side effects or broader discovery', async () => {
  const f = await fixture();
  try {
    const draft = await f.client.createDraft(f.workspace.id, request, signal());
    const before = await f.client.inspect(draft.id, { view: 'metadata', maxOutputBytes: 12000, continuation: null }, signal());
    assert(before.kind === 'metadata');
    const receipts: { path: string; whole: string; ranged: string }[] = [];
    for (const path of ['private/Hidden.swift', 'cursor/Hidden.swift']) {
      const whole = await f.client.explore(f.workspace.id, { name: 'read_file',
        input: readValidator.Parse(readValidator.Default({ root: 'r', path, maxOutputBytes: 12000 })) }, signal(), draft.id);
      assert('kind' in whole && whole.kind === 'read'); assert.equal(whole.content, body);
      const ranged = await f.client.explore(f.workspace.id, { name: 'read_file',
        input: readValidator.Parse(readValidator.Default({ root: 'r', path, start_line: 2, limit: 1, maxOutputBytes: 12000 })) }, signal(), draft.id);
      assert('kind' in ranged && ranged.kind === 'read'); assert.equal(ranged.content, 'second line\n');
      receipts.push({ path, whole: whole.content, ranged: ranged.content });
    }
    const after = await f.client.inspect(draft.id, { view: 'metadata', maxOutputBytes: 12000, continuation: null }, signal());
    assert(after.kind === 'metadata'); assert.equal(after.revision, before.revision); assert.deepEqual(after.items, before.items);
    const tree = await f.client.explore(f.workspace.id, { name: 'get_file_tree', input: treeValidator.Parse(treeValidator.Default({
      type: 'files', mode: 'full', selection: null, maxOutputBytes: 12000 })) }, signal());
    assert('kind' in tree && tree.kind === 'tree'); assert(!tree.tree.includes('Hidden.swift'));
    const search = await f.client.explore(f.workspace.id, { name: 'file_search', input: searchValidator.Parse(searchValidator.Default({
      mode: 'path', query: { kind: 'literal', text: 'Hidden' }, maxOutputBytes: 12000 })) }, signal());
    assert('kind' in search && search.kind === 'search'); assert.equal(search.counts.pathMatches, 0);
    for (const path of ['private/Excluded.swift', 'private/Credential.swift', 'private/Link.swift']) {
      await assert.rejects(f.client.explore(f.workspace.id, { name: 'read_file',
        input: readValidator.Parse(readValidator.Default({ root: 'r', path, maxOutputBytes: 12000 })) }, signal()), /pathDenied|symlink/);
    }
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/exact-read-registration.json', JSON.stringify({ before, receipts, tree, search }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

for (const route of ['initial', 'required', 'document'] as const) test(`explicit ignored ${route} acquisition works before registration`, async () => {
  const f = await fixture();
  try {
    const source = { root: 'r', path: 'private/Hidden.swift' };
    const input: ContextBuildRequest = { ...request,
      initialSelection: { codemapMode: 'manual', sources: route === 'initial' ? [{ kind: 'full', source }] : [] },
      requiredSources: route === 'required' ? [{ kind: 'slices', source, ranges: [{ start: 2, end: 2, description: null }] }] : [],
      documents: route === 'document' ? [{ kind: 'localDocument', id: 'ignored', role: 'evidence', source }] : [] };
    const draft = await f.client.createDraft(f.workspace.id, input, signal());
    const ready = await f.client.finalize(draft.id, signal()); assert(ready.kind === 'ready');
    await verifyBundle(ready.directory);
    const packet = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert(packet.includes(route === 'required' ? 'second line\n' : body));
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/exact-${route}-acquisition.json`, JSON.stringify({ ready }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});
