import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { identity } from '../src/context/material-store.js';
import { canonicalJSON } from '../src/workspace/values.js';

const sections = ['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions'] as const;
type Section = typeof sections[number];
const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');

test('public packets preserve source section permutations and repetitions with exact accounting and saved integrity', async () => {
  const base = await mkdtemp(join(tmpdir(), 'smip-section-order-')), root = join(base, 'root'), output = join(base, 'out');
  await mkdir(root); await mkdir(output); await mkdir('test-output', { recursive: true });
  const full = 'struct Main { let peer: Peer }\n// Exact raw body λ🙂\n', peer = 'struct Peer { let value: Int }\n';
  const sliced = 'outside\nselected 🙂\nend\n', document = 'Required document\n```\nλ\n', patch = 'Required patch\n';
  await writeFile(join(root, 'Main.swift'), 'struct Main { let peer: Peer }\n');
  await writeFile(join(root, 'Peer.swift'), peer); await writeFile(join(root, 'slice.txt'), sliced);
  const runGit = (args: string[]) => execFileSync(git, args, { cwd: root,
    env: { PATH: '/usr/bin:/bin', HOME: base, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  runGit(['init', '-q']); runGit(['config', 'user.name', 'Fixture']); runGit(['config', 'user.email', 'fixture@example.invalid']);
  runGit(['add', '.']); runGit(['commit', '-qm', 'base']); await writeFile(join(root, 'Main.swift'), full);
  const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: {}, terminationGraceMs: 100, git: { executable: git } });
  const signal = new AbortController().signal;
  let caseIndex = 0;
  const proof: { order: Section[]; directory: string; bytes: number; sha256: string }[] = [];
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
    const check = async (order: Section[]) => {
      const input = { task: 'Literal prompt λ', constraints: 'Keep every body.', purpose: 'review' as const, enhancementMode: 'preserve' as const,
        initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: true,
        copyPreset: 'codeReview' as const, storedPrompts: [], promptSectionsOrder: order,
        requiredSources: [{ kind: 'full' as const, source: { root: 'r', path: 'Main.swift' } },
          { kind: 'slices' as const, source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: 'selected' }] }],
        documents: [{ kind: 'suppliedDocument' as const, id: 'plan.md', role: 'plan' as const, origin: 'fixture', text: document }],
        patches: [{ kind: 'suppliedPatch' as const, id: 'changes', root: 'r', origin: 'fixture', text: patch,
          comparison: { kind: 'supplied' as const, base: 'before', target: 'after' }, coverage: [], targets: [
            { path: 'Main.swift', identity: identity(full), mode: '100644' as const },
            { path: 'Peer.swift', identity: identity(peer), mode: '100644' as const },
            { path: 'slice.txt', identity: identity(sliced), mode: '100644' as const }] }],
        budgetUnits: 100000, discoveryHints: [], outputName: 'packet-' + caseIndex++ };
      const draft = await workspace.createDraft(input, signal);
      const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, signal); assert(costs.kind === 'costs');
      const ready = await draft.finalize(signal); assert(ready.kind === 'ready');
      const context = await readFile(join(ready.directory, 'context.md')), span = ready.manifest.fileTree.span;
      const tree = context.subarray(span.offset, span.offset + span.length).toString();
      const codemap = ready.manifest.materials.find(record => record.kind === 'source' && record.selection.kind === 'codemap'); assert(codemap);
      const body = codemap.spans[0]!;
      const automatic = ready.manifest.automaticGit?.span; assert(automatic);
      const gitText = context.subarray(automatic.offset, automatic.offset + automatic.length).toString();
      const bridge = runtime.makeBridge();
      try {
        const files: Extract<NativeOperation, { kind: 'renderClipboard' }>['input']['files'] = [
          { name: 'Main.swift', path: 'r/Main.swift', content: full, ranges: null },
          { name: 'slice.txt', path: 'r/slice.txt', content: sliced, ranges: [{ start: 2, end: 2, description: 'selected' }] },
          { name: 'plan.md', path: 'Plan: fixture (plan.md)', content: document, ranges: null },
        ].map(file => ({ file: { id: file.name, rootID: 'r', name: file.name, relativePath: file.path, fullPath: file.path },
          role: 'ordinary' as const, isCodemap: false, loadedContent: file.content, lineRanges: file.ranges, rootFolderPath: null }));
        files.push({ file: { id: 'peer', rootID: 'r', name: 'Peer.swift', relativePath: 'r/Peer.swift', fullPath: 'r/Peer.swift' },
          role: 'ordinary', isCodemap: true, loadedContent: null, lineRanges: null, rootFolderPath: null });
        const reference = await bridge.request({ kind: 'renderClipboard', input: { files, codemapPresentation: {
          renderedEntriesByFileID: { peer: { text: context.subarray(body.offset, body.offset + body.length).toString() } } },
          filePathDisplay: 'full', fileTreeContent: tree, gitDiff: gitText + '\n\n' + patch,
          metaInstructions: [{ title: 'Constraints', content: input.constraints }], userInstructions: input.task,
          includeFiles: true, includeUserPrompt: true, includeSavedPrompts: true, includeDatetimeInUserInstructions: false,
          promptSectionsOrder: order, disabledPromptSections: [], duplicateUserInstructionsAtTop: true, tabTitle: null } }, signal);
        assert.equal(context.toString(), reference.result.text);
      } finally { await bridge.close(); }
      assert.equal(costs.measurement.bytes, context.length); assert.equal(costs.measurement.units, ready.manifest.accounting.units);
      const source = ready.manifest.materials.find(record => record.kind === 'source' && record.selection.source.path === 'Main.swift');
      assert(source?.kind === 'source' && source.frame);
      assert.equal(source.spans[0]!.offset, context.indexOf(Buffer.from(full)));
      const cost = costs.items.find(cost => 'id' in cost && cost.id === source.id); assert(cost && 'bytes' in cost);
      assert.equal(cost.bytes, source.frame.length * order.filter(section => section === 'fileContents').length);
      const automaticCost = costs.items.find(cost => 'id' in cost && cost.id === 'automaticReviewGit');
      assert(automaticCost && 'bytes' in automaticCost);
      assert.equal(automaticCost.bytes, automatic.length * order.filter(section => section === 'gitDiff').length);
      const codemapCost = costs.items.find(cost => 'id' in cost && cost.id === codemap.id); assert(codemapCost && 'bytes' in codemapCost);
      assert.equal(codemapCost.bytes, body.length * order.filter(section => section === 'fileMap').length);
      assert.equal(new Set(ready.manifest.materials.map(material => material.id)).size, ready.manifest.materials.length);
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, runtime, signal);
      proof.push({ order, directory: ready.directory, bytes: context.length, sha256: identity(context).sha256 });
      return ready;
    };
    const repeated = await check([...sections, ...sections]);
    const orders = fc.tuple(fc.shuffledSubarray([...sections], { minLength: sections.length, maxLength: sections.length }),
      fc.array(fc.constantFrom(...sections))).map(([permutation, repeats]) => [...permutation, ...repeats]);
    await fc.assert(fc.asyncProperty(orders, async order => { await check(order); }));
    const original = await readFile(join(repeated.directory, 'context.md')), forged = Buffer.from(original);
    const second = forged.indexOf(Buffer.from(full), forged.indexOf(Buffer.from(full)) + Buffer.byteLength(full)); assert(second >= 0);
    forged[second] = 'X'.charCodeAt(0);
    const manifest = structuredClone(repeated.manifest); manifest.files.context = identity(forged);
    await writeFile(join(repeated.directory, 'context.md'), forged);
    await writeFile(join(repeated.directory, 'manifest.json'), canonicalJSON(manifest));
    await assert.rejects(verifyBundle(repeated.directory), /bundleIntegrityFailed/);
    await writeFile(join(repeated.directory, 'context.md'), original);
    await writeFile(join(repeated.directory, 'manifest.json'), canonicalJSON(repeated.manifest));
    await writeFile('test-output/packet-section-order-proof.json', JSON.stringify({ proof, duplicateTamperRejected: true }, null, 2) + '\n');
  } finally { await runtime.close(); }
});
