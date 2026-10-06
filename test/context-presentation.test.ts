import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyCurrentBundle } from '../src/index.js';
import { prepareDeliveryFixture, verifyDeliveryMaterials } from './fixtures/delivery-fixture.js';

test('recipient Markdown presents complete handoff and material paths while retaining exact verified bodies', async () => {
  const fixture = await prepareDeliveryFixture();
  const runtime = new SmipRuntime(fixture.options), signal = new AbortController().signal;
  const handoff = {
    clarifiedTask: 'Inspect the complete packet.\n\nKeep evidence separate from instructions.',
    architecture: 'The Swift files provide implementation and structural evidence.\n\nThe complete plan and report explain the review context.',
    relationships: ['Delivery supplies complete source.', 'Summary supplies a code map; the patch covers deletion and addition.'],
    ambiguities: ['These are syntax-derived relationships, not compiler-resolved dependencies.'],
  };
  try {
    const workspace = await runtime.declare(fixture.input.workspace, signal);
    const draft = await workspace.createDraft(fixture.input.request, signal);
    await draft.update({ expectedRevision: 0, maxOutputBytes: 12000,
      mutation: { kind: 'handoff', handoff } }, signal);
    const admitted = draft.inspect({ view: 'material', materialId: 'patch:changes', maxOutputBytes: 12000, continuation: null });
    assert.equal(admitted.kind, 'material');
    if (admitted.kind !== 'material') assert.fail('Missing patch material');
    const patch = admitted.lines.map(line => line.text).join('');
    const result = await draft.finalize(signal);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail('Missing ready packet');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    assert(context.includes(handoff.clarifiedTask));
    assert(context.includes(handoff.architecture));
    for (const fact of [...handoff.relationships, ...handoff.ambiguities]) {
      assert(context.split('\n').includes('- ' + fact), 'Handoff facts must be readable list items');
    }
    for (const path of ['r/full.swift', 'r/slice.txt', 'r/summary.swift']) {
      assert(context.split('\n').some(line => line.startsWith('## ') && line.includes(path)), 'Material headings must name their source path');
    }
    const overview = context.slice(0, context.indexOf(fixture.evidence));
    assert(!overview.includes('"architecture":'));
    assert(!overview.includes('"inode":'));
    assert(!overview.includes('"representation":'));
    assert.deepEqual(result.manifest.handoff, handoff);
    const proof = await verifyDeliveryMaterials(result.directory, { ...fixture, handoff }, patch);
    await verifyCurrentBundle(result.directory, runtime, signal);
    await writeFile(resolve('test-output/context-presentation.json'), JSON.stringify({ directory: result.directory, proof }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
