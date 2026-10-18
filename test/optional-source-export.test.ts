import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, verifyCurrentBundle, type ContextBuildRequest } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { canonicalJSON, sha256 } from '../src/workspace/values.js';

const signal = () => new AbortController().signal;
const omissions = Compile(Type.Object({ unavailableRoots: Type.Array(Type.Object({ root: Type.String(), code: Type.String(),
  sources: Type.Array(Type.Object({ id: Type.String(), selection: Type.Object({ kind: Type.String() }), identity: Type.Object({ sha256: Type.String() }) })) })) }));

async function fixture(mode: 'manual' | 'automatic', required: boolean, restoreBeforeClaim: boolean) {
  const base = await mkdtemp(join(tmpdir(), 'smip-optional-source-export-'));
  const r = join(base, 'r'), s = join(base, 's'), out = join(base, 'out'); await mkdir(r); await mkdir(s); await mkdir(out);
  for (const [root, name] of [[r, 'Omitted'], [s, 'Delivered']] as const) {
    await writeFile(join(root, 'Seed.swift'), `struct ${name}Seed { let value: ${name}Peer }\n`);
    await writeFile(join(root, 'Peer.swift'), `struct ${name}Peer { let name: String }\n`);
  }
  await writeFile(join(r, 'slice.txt'), 'first\nomitted slice content\nlast\n');
  const restore = async () => { await rename(r, join(base, 'replacement')); await rename(join(base, 'original'), r); };
  let armed = restoreBeforeClaim;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
          if (armed && operation.kind === 'readExport') { armed = false; await restore(); }
          return super.request(operation, requestSignal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
  }
  const runtime = new Runtime({ cachePath: join(base, 'cache'), contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: r }, { name: 's', absolutePath: s }], exclusions: [], outputRoot: out }, signal());
  const sources = [{ kind: 'full' as const, source: { root: 'r', path: 'Seed.swift' } },
    { kind: 'slices' as const, source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: 'Omitted slice' }] },
    { kind: 'full' as const, source: { root: 's', path: 'Seed.swift' } }];
  const initialSelection: ContextBuildRequest['initialSelection'] = mode === 'automatic' ? { codemapMode: mode, sources }
    : { codemapMode: mode, sources: [...sources, { kind: 'codemap', source: { root: 'r', path: 'Peer.swift' } },
      { kind: 'codemap', source: { root: 's', path: 'Peer.swift' } }] };
  const draft = await workspace.createDraft({ task: 'Export available context', initialSelection, constraints: '', enhancementMode: 'preserve',
    purpose: 'investigation', requiredSources: required ? [sources[0]!] : [], documents: [], patches: [], discoveryHints: [],
    copyPreset: mode === 'manual' ? 'standard' : 'codeReview', storedPrompts: [], duplicateUserInstructionsAtTop: false,
    budgetUnits: 200000, outputName: 'packet' }, signal());
  await rename(r, join(base, 'original')); await mkdir(r);
  await writeFile(join(r, 'Seed.swift'), 'UNAUTHORIZED REPLACEMENT\n');
  await writeFile(join(r, 'slice.txt'), 'UNAUTHORIZED SLICE\n');
  return { base, r, s, out, runtime, workspace, draft, restore };
}

for (const mode of ['manual', 'automatic'] as const) test(`${mode} optional root export records omissions and verifies included bodies`, async () => {
  const f = await fixture(mode, false, false);
  try {
    if (mode === 'automatic') await f.workspace.refresh(signal());
    const selection = f.draft.selectionProjection();
    const result = await f.draft.finalize(signal()); assert(result.kind === 'ready', JSON.stringify(result));
    const recorded = omissions.Parse(result.manifest);
    assert.equal(recorded.unavailableRoots.length, 1); assert.equal(recorded.unavailableRoots[0]?.root, 'r');
    assert.equal(recorded.unavailableRoots[0]?.code, 'rootChanged');
    assert.deepEqual(recorded.unavailableRoots[0]?.sources.map(source => source.selection.kind).sort(), mode === 'manual' ? ['codemap', 'full', 'slices'] : ['full', 'slices']);
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    const handoff = await readFile(join(result.directory, 'handoff.md'), 'utf8');
    assert(context.includes('struct DeliveredSeed')); assert(context.includes('DeliveredPeer'));
    assert(!context.includes('struct Omitted') && !context.includes('omitted slice content') && !context.includes('UNAUTHORIZED'));
    assert(handoff.includes('unavailableRoots') && handoff.includes('rootChanged'));
    assert.deepEqual(f.draft.selectionProjection(), selection);
    await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, f.runtime, signal());
    const terminal = await f.draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 100000 }, signal());
    assert(terminal.kind === 'costs'); assert.equal(terminal.measurement.bytes, result.manifest.accounting.bytes);
    assert.equal(terminal.token_accounting.status, 'incomplete');
    assert.deepEqual(terminal.token_accounting.incomplete_components, mode === 'manual' ? ['files', 'codemap_presentation'] : ['files']);
    const manifestPath = join(result.directory, 'manifest.json'), original = await readFile(manifestPath);
    const forged = structuredClone(result.manifest);
    forged.request.requiredSources.push({ kind: 'full', source: { root: 'r', path: 'Seed.swift' } });
    forged.requestDigest = sha256(canonicalJSON(forged.request));
    await writeFile(manifestPath, canonicalJSON(forged));
    await assert.rejects(verifyBundle(result.directory), /bundleIntegrityFailed/); await writeFile(manifestPath, original);
    await f.restore();
    await assert.rejects(verifyCurrentBundle(result.directory, f.runtime, signal()), /sourceAvailabilityChanged/);
    await verifyBundle(result.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/optional-source-export-${mode}.json`, JSON.stringify({ result, terminal, restoredRootIsNotCurrent: true }, null, 2) + '\n');
  } finally { await f.draft.close(); await f.workspace.close(); await f.runtime.close(); }
});

for (const scenario of ['required', 'restoreBeforeClaim'] as const) test(`${scenario} cannot publish an omitted-source packet`, async () => {
  const f = await fixture('manual', scenario === 'required', scenario === 'restoreBeforeClaim');
  try {
    await assert.rejects(f.draft.finalize(signal()), scenario === 'required' ? /rootChanged|notFound/ : /sourceAvailabilityChanged/);
    await assert.rejects(readFile(join(f.out, 'packet/manifest.json')), /ENOENT/);
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/optional-source-${scenario}.json`, JSON.stringify({ manifestAbsent: true }, null, 2) + '\n');
  } finally { await f.draft.close(); await f.workspace.close(); await f.runtime.close(); }
});
