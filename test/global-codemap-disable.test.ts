import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle } from '../src/index.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { contextRequestValidator } from '../src/contracts/context.js';
import { readValidator, searchValidator, structureValidator } from '../src/contracts/exploration.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { failureCode } from '../src/runtime/tool-result.js';
import { copyContext } from './fixtures/copy-context.js';

class DisabledEngineRuntime extends MipmuxRuntime {
  override makeBridge() {
    class Bridge extends BridgeClient {
      override async request<O extends NativeOperation>(input: O, signal: AbortSignal) {
        if (input.kind === 'extract') throw new Error('The disabled extraction boundary is unavailable');
        return super.request(input, signal);
      }
    }
    return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
  }
}

for (const warm of [false, true]) test(`global codemap disable preserves ordinary context with a ${warm ? 'warm' : 'cold'} artifact cache`, async () => {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-global-codemap-disable-'));
  const root = join(base, 'source'), output = join(base, 'output');
  await mkdir(root); await mkdir(output);
  const text = 'public struct Alpha { let beta: Beta }\n';
  await writeFile(join(root, 'Alpha.swift'), text);
  await writeFile(join(root, 'Beta.swift'), 'public struct Beta { let value: Int }\n');
  await mkdir(join(root, 'private'));
  await writeFile(join(root, '.repo_ignore'), 'private/\n');
  await writeFile(join(root, 'private/Hidden.swift'), 'struct Hidden {}\n');
  const options = { cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {}, terminationGraceMs: 100 };
  const spec = { roots: [{ name: 'r', absolutePath: root }], outputRoot: output, exclusions: [] };
  const signal = () => new AbortController().signal;
  const request = contextRequestValidator.Parse({ task: 'Inspect Alpha', constraints: '', enhancementMode: 'preserve', purpose: 'investigation',
    initialSelection: { codemapMode: 'automatic', sources: [{ kind: 'full', source: { root: 'r', path: 'Alpha.swift' } }] },
    requiredSources: [], documents: [], patches: [], copyPreset: 'standard', duplicateUserInstructionsAtTop: false,
    budgetUnits: 200000, discoveryHints: [], outputName: 'packet' });
  let historical: string | null = null;
  if (warm) {
    const enabled = new MipmuxRuntime({ ...options, copyContext: copyContext() });
    try {
      const workspace = await enabled.declare(spec, signal()); await workspace.refresh(signal());
      const draft = await workspace.createDraft({ ...request, outputName: 'historical' }, signal()), ready = await draft.finalize(signal());
      assert.equal(ready.kind, 'ready');
      assert(ready.manifest.materials.some(material => material.kind === 'source' && material.selectionOrigin === 'inferred'));
      historical = ready.directory;
    }
    finally { await enabled.close(); }
  }
  const captured = copyContext(); captured.codeMapsGloballyDisabled = true; captured.current.codeMapUsage = 'complete';
  const runtime = new DisabledEngineRuntime({ ...options, copyContext: captured });
  try {
    const workspace = await runtime.declare(spec, signal()); await workspace.refresh(signal());
    const operation = await workspace.openOperation(signal());
    try {
      const graph = await operation.getCodeStructure(structureValidator.Parse(structureValidator.Default({
        seeds: [{ kind: 'file', root: 'r', path: 'Alpha.swift' }], maxOutputBytes: 100000 })));
      assert.equal(graph.kind, 'structure');
      if (graph.kind !== 'structure') assert.fail('Missing structural diagnostic');
      assert.equal(graph.status, 'unavailable'); assert.deepEqual(graph.files, []);
      assert.deepEqual(graph.issues, [{ code: 'codemaps_disabled', phase: 'graph_snapshot',
        retryable: false, message: 'Codemap generation is disabled.' }]);
      assert.deepEqual(graph.roots, []);
      assert.deepEqual(graph.summary, { seeds: 0, nodes: 0, edges: 0, files: 0, tokens: 0 });
      const demand = await operation.requestExplicitCodemap({ root: 'r', path: 'Alpha.swift' });
      try { assert.equal((await demand.result).structural.kind, 'pending'); }
      finally { await demand.release(); }
      const hidden = await operation.requestExplicitCodemap({ root: 'r', path: 'private/Hidden.swift' });
      try { assert.equal((await hidden.result).structural.kind, 'pending'); }
      finally { await hidden.release(); }
      const refreshed = await workspace.refresh(signal());
      const managed = refreshed.entries.find(entry => entry.path === 'private/Hidden.swift');
      assert.equal(managed?.kind, 'file');
      if (managed?.kind === 'file') { assert.equal(managed.visibility, 'managedOnly'); assert.equal(managed.structural.kind, 'pending'); }
      const read = await operation.readFile(readValidator.Parse(readValidator.Default({ root: 'r', path: 'Alpha.swift', maxOutputBytes: 100000 })));
      assert.equal(read.kind, 'read'); if (read.kind === 'read') assert.equal(read.content, text);
      const search = await operation.fileSearch(searchValidator.Parse(searchValidator.Default({ mode: 'content',
        query: { kind: 'literal', text: 'Alpha' }, maxOutputBytes: 100000 })));
      assert(search.kind === 'search');
      assert.equal(search.counts.matchingLines, 1);
      const draft = await workspace.createDraft(request, signal());
      const original = draft.selectionProjection();
      for (const input of [{ op: 'add', mode: 'codemap_only' }, { op: 'demote' }]) {
        await assert.rejects(draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ ...input,
          paths: ['r/Alpha.swift'], maxOutputBytes: 100000 })), signal()), error => failureCode(error) === 'invalidSelection');
        assert.equal(draft.revision, 0); assert.deepEqual(draft.selectionProjection(), original);
      }
      await assert.rejects(draft.update({ expectedRevision: 0, maxOutputBytes: 100000, mutation: {
        kind: 'upsert', selection: { kind: 'codemap', source: { root: 'r', path: 'Alpha.swift' } } } }, signal()),
      error => failureCode(error) === 'invalidSelection');
      const selected = { kind: 'codemap' as const, source: { root: 'r', path: 'Alpha.swift' } };
      await assert.rejects(workspace.createDraft({ ...request, initialSelection: { codemapMode: 'manual', sources: [] },
        requiredSources: [selected] }, signal()), error => failureCode(error) === 'codemapUnavailable');
      const optional = await workspace.createDraft({ ...request, outputName: 'optional',
        initialSelection: { codemapMode: 'manual', sources: [selected] } }, signal());
      const optionalReply = await optional.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get',
        maxOutputBytes: 100000 })), signal());
      assert.equal(optionalReply.code_structure, undefined); assert.equal(optional.revision, 0);
      const optionalReady = await optional.finalize(signal()); assert.equal(optionalReady.kind, 'ready');
      assert.equal(optionalReady.manifest.materials.length, 0);
      assert.deepEqual(optionalReady.manifest.manualPresentation?.canonicalSources, [selected]);
      await verifyBundle(optionalReady.directory);
      const selection = await draft.manageSelection(selectionValidator.Parse(selectionValidator.Default({ op: 'get',
        maxOutputBytes: 100000 })), signal());
      assert.equal(selection.code_structure, undefined);
      const exported = await draft.prompt({ op: 'export', copy_preset: 'manual', path: 'export.md', maxOutputBytes: 100000 }, signal());
      assert.equal(exported.op, 'export');
      assert((await readFile(join(output, 'export.md'), 'utf8')).includes(text));
      const ready = await draft.finalize(signal());
      assert(ready.kind === 'ready');
      assert.equal(ready.manifest.materials.filter(material => material.kind === 'source' && material.selectionOrigin === 'inferred').length, 0);
      assert((await readFile(join(ready.directory, 'context.md'), 'utf8')).includes(text));
      await verifyBundle(ready.directory);
      if (historical !== null) await verifyBundle(historical);
      assert.equal(draft.revision, 0);
      await mkdir('test-output', { recursive: true });
      await writeFile(`test-output/global-codemap-disabled-${warm ? 'warm' : 'cold'}.json`, JSON.stringify({ graph,
        directory: ready.directory, historical, materials: ready.manifest.materials }, null, 2) + '\n');
    } finally { await operation.close(); }
  } finally { await runtime.close(); }
});
