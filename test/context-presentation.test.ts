import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { prepareDeliveryFixture, verifyDeliveryMaterials } from './fixtures/delivery-fixture.js';
import { loadVerifiedBundle } from '../src/context/verify.js';
import { renderBundle } from '../src/context/render.js';
import { identity } from '../src/context/material-store.js';
import { canonicalJSON } from '../src/workspace/values.js';

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
    assert(context.includes('File: r/full.swift\n```swift\n' + fixture.full.slice(1) + '\n```'));
    assert(context.includes('File: r/slice.txt\n(lines 2-4: Exact sentinel range)\n```txt\n' +
      'SLICE BEGIN 🙂\r\nExact middle e\u0301\rSLICE END\n\n```'));
    assert(context.includes('File: r/summary.swift\nImports:'));
    const overview = context.slice(0, context.indexOf(fixture.evidence));
    assert(!overview.includes('"architecture":'));
    assert(!overview.includes('"inode":'));
    assert(!overview.includes('"representation":'));
    assert.equal(result.manifest.prompt, fixture.input.request.task + addition);
    const proof = await verifyDeliveryMaterials(result.directory, fixture, patch);
    await verifyCurrentBundle(result.directory, runtime, signal);
    const saved = await loadVerifiedBundle(result.directory);
    for (const mutation of ['path', 'fence'] as const) {
      const manifest = structuredClone(result.manifest);
      const materials = saved.materials.map(material => {
        if (material.record.kind !== 'source' || material.record.selection.kind !== 'full' || !material.sourceBlock) return material;
        const text = mutation === 'path' ? material.sourceBlock.text.replace('File: r/', 'File: x/')
          : material.sourceBlock.text.replace('```swift', '```textx');
        return { ...material, sourceBlock: { ...material.sourceBlock, text } };
      });
      const forged = renderBundle({ request: manifest.request, inventory: manifest.inventory, codemapMode: manifest.codemapMode,
        prompt: manifest.prompt, materials });
      manifest.materials = forged.records;
      manifest.files = { context: identity(forged.context), handoff: identity(forged.handoff) };
      manifest.accounting.bytes = forged.measurement.bytes; manifest.accounting.units = forged.measurement.units;
      await writeFile(join(result.directory, 'context.md'), forged.context);
      await writeFile(join(result.directory, 'handoff.md'), forged.handoff);
      await writeFile(join(result.directory, 'manifest.json'), canonicalJSON(manifest));
      await assert.rejects(verifyBundle(result.directory), /bundleIntegrityFailed/);
    }
    const restored = renderBundle({ request: result.manifest.request, inventory: result.manifest.inventory,
      codemapMode: result.manifest.codemapMode, prompt: result.manifest.prompt, materials: saved.materials });
    await writeFile(join(result.directory, 'context.md'), restored.context);
    await writeFile(join(result.directory, 'handoff.md'), restored.handoff);
    await writeFile(join(result.directory, 'manifest.json'), canonicalJSON(result.manifest));
    await verifyBundle(result.directory);
    await writeFile(resolve('test-output/context-presentation.json'), JSON.stringify({ directory: result.directory, proof }) + '\n');
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
