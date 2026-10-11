import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyCurrentBundle } from '../src/index.js';
import { prepareDeliveryFixture, verifyDeliveryMaterials } from './fixtures/delivery-fixture.js';

test('recipient Markdown retains the literal prompt and material paths with exact verified bodies', async () => {
  const fixture = await prepareDeliveryFixture();
  const runtime = new SmipRuntime(fixture.options), signal = new AbortController().signal;
  const addition = '\n\n<discovered_architecture>\nDelivery supplies complete source.\n' +
    'Summary supplies a code map; the patch covers deletion and addition.\n' +
    'These are syntax-derived relationships, not compiler-resolved dependencies.\n</discovered_architecture>';
  try {
    const workspace = await runtime.declare(fixture.input.workspace, signal);
    const draft = await workspace.createDraft(fixture.input.request, signal);
    await draft.update({ expectedRevision: 0, maxOutputBytes: 12000,
      mutation: { kind: 'prompt', op: 'append', text: addition } }, signal);
    const admitted = draft.inspect({ view: 'material', materialId: 'patch:changes', maxOutputBytes: 12000, continuation: null });
    assert.equal(admitted.kind, 'material');
    if (admitted.kind !== 'material') assert.fail('Missing patch material');
    const patch = admitted.lines.map(line => line.text).join('');
    const result = await draft.finalize(signal);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail('Missing ready packet');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    assert(context.includes(addition));
    for (const path of ['r/full.swift', 'r/slice.txt', 'r/summary.swift']) {
      assert(context.split('\n').some(line => line.startsWith('## ') && line.includes(path)), 'Material headings must name their source path');
    }
    const overview = context.slice(0, context.indexOf(fixture.evidence));
    assert(!overview.includes('"architecture":'));
    assert(!overview.includes('"inode":'));
    assert(!overview.includes('"representation":'));
    assert.equal(result.manifest.prompt, fixture.input.request.task + addition);
    const proof = await verifyDeliveryMaterials(result.directory, fixture, patch);
    await verifyCurrentBundle(result.directory, runtime, signal);
    await writeFile(resolve('test-output/context-presentation.json'), JSON.stringify({ directory: result.directory, proof }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
