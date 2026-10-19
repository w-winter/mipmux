import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle } from '../src/index.js';
import { prepareDeliveryFixture, verifyDeliveryMaterials } from './fixtures/delivery-fixture.js';

test('public mixed packet preserves every original body and final task above ordinary Pi read limits', async () => {
  const fixture = await prepareDeliveryFixture();
  const runtime = new SmipRuntime(fixture.options), signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare(fixture.input.workspace, signal);
    const draft = await workspace.createDraft(fixture.input.request, signal);
    await draft.prompt({ expectedRevision: 0, maxOutputBytes: 12000,
      op: 'append', text: '\n\n' + JSON.stringify(fixture.handoff)  }, signal);
    const admittedPatch = (await draft.inspect({ view: 'material', materialId: 'patch:changes', maxOutputBytes: 12000, continuation: null }, new AbortController().signal));
    assert.equal(admittedPatch.kind, 'material');
    if (admittedPatch.kind !== 'material') assert.fail('Missing complete admitted patch');
    assert.equal(admittedPatch.truncated, false);
    const expectedPatch = admittedPatch.lines.map(line => line.text).join('');
    await writeFile(join(fixture.directory, 'admitted-patch.txt'), expectedPatch);
    const result = await draft.finalize(signal);
    assert.equal(result.kind, 'ready'); if (result.kind !== 'ready') assert.fail('Missing packet');
    await verifyBundle(result.directory);
    const receipt = await verifyDeliveryMaterials(result.directory, fixture, expectedPatch);
    assert(receipt.context.byteCount > 50 * 1024);
    await writeFile(resolve('test-output/group-e-delivery.json'), JSON.stringify({ directory: result.directory,
      request: join(fixture.directory, 'build.json'), fixtureDirectory: fixture.directory, receipt }) + '\n');
    assert((await readFile(join(result.directory, 'context.md'), 'utf8')).includes(fixture.input.request.task));
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});
