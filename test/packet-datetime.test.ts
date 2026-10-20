import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import type { NativeOperation, NativeResult } from '../src/contracts/native.js';
import { canonicalJSON } from '../src/workspace/values.js';
import { identity } from '../src/context/material-store.js';

const evidenceDate = '1999-01-01T00:00';
const sourceBody = 'Exact source λ🙂\n<user_instructions date="' + evidenceDate + '">\nordinary evidence\n</user_instructions>\n';
type NativeMode = 'normal' | 'clock' | 'body';

function changeNativeOutput(result: NativeResult, mode: NativeMode): void {
  if (result.kind !== 'preparedClipboard' || mode === 'normal') return;
  if (mode === 'body') result.text = result.text.replace(evidenceDate, '1999-01-01T00:01');
  else {
    const first = result.text.match(/^<user_instructions date="([^"]+)">/); assert(first);
    result.text = result.text.split('<user_instructions date="' + first[1] + '">')
      .join('<user_instructions date="2001-02-03T04:05">');
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'mipmux-datetime-'));
  await mkdir(join(base, 'root')); await mkdir(join(base, 'out')); await mkdir('test-output', { recursive: true });
  await writeFile(join(base, 'root/file.txt'), sourceBody);
  let mode: NativeMode = 'normal';
  class Runtime extends MipmuxRuntime {
    override async renderPresentation<O extends Extract<NativeOperation, { kind: 'listCopyPresets' | 'resolveCopyPreset' | 'renderFileTree' | 'renderPreparedClipboard' |
      'planClipboardPresentation' | 'renderDiscoveryPrompt' | 'renderAutomaticReviewGit' | 'calculateTokenStats' }>>(input: O, signal: AbortSignal) {
      const result = await super.renderPresentation(input, signal);
      changeNativeOutput(result, mode);
      return result;
    }
  }
  const runtime = new Runtime({ copyContext: copyContext(), cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { TZ: 'UTC', LC_ALL: 'en_US.UTF-8' }, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(base, 'root') }],
    exclusions: [], outputRoot: join(base, 'out') }, signal);
  return { base, runtime, workspace, signal, setMode: (value: typeof mode) => { mode = value; } };
}

for (const task of ['Literal prompt λ', '']) test(`datetime export preserves captured headers and source evidence for ${task ? 'nonempty' : 'empty'} instructions`, async () => {
  const f = await fixture();
  try {
    const input = { task, constraints: 'Keep the source.', purpose: 'investigation' as const, enhancementMode: 'preserve' as const,
      initialSelection: { codemapMode: 'manual' as const, sources: [] }, duplicateUserInstructionsAtTop: true,
      includeDatetimeInUserInstructions: true, promptSectionsOrder: ['userInstructions' as const, 'fileContents' as const,
        'fileMap' as const, 'gitDiff' as const, 'constraints' as const, 'userInstructions' as const],
      copyPreset: 'standard' as const, requiredSources: [{ kind: 'full' as const, source: { root: 'r', path: 'file.txt' } }],
      documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'packet' };
    const before = new Date().toISOString().slice(0, 16);
    const draft = await f.workspace.createDraft(input, f.signal);
    const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 100000, continuation: null }, f.signal); assert(costs.kind === 'costs');
    const ready = await draft.finalize(f.signal); assert(ready.kind === 'ready');
    const after = new Date().toISOString().slice(0, 16);
    const context = await readFile(join(ready.directory, 'context.md'), 'utf8');
    assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
    assert.equal(costs.measurement.units, ready.manifest.accounting.units);
    const record = ready.manifest.materials.find(record => record.kind === 'source'); assert(record);
    const span = record.spans[0]!;
    assert.equal(Buffer.from(context).subarray(span.offset, span.offset + span.length).toString(), sourceBody);
    await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, f.signal);
    if (task) {
      const first = context.match(/^<user_instructions date="([^"]+)">/); assert(first);
      const date = first[1]!; assert(date >= before && date <= after);
      const header = '<user_instructions date="' + date + '">'; assert.equal(context.split(header).length - 1, 3);
      f.setMode('clock'); await verifyCurrentBundle(ready.directory, f.runtime, f.signal);
      f.setMode('body'); await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, f.signal), /presentationChanged/);
      f.setMode('normal');
      const end = context.lastIndexOf(header), changedDate = date.slice(0, -1) + (date.endsWith('0') ? '1' : '0');
      const corruptions = [context.slice(0, end) + context.slice(end).replace(date, changedDate),
        context.split(header).join('<user_instructions date="xxxx-xx-xxTxx:xx">')];
      for (const forged of corruptions) {
        const manifest = structuredClone(ready.manifest); manifest.files.context = identity(forged);
        await writeFile(join(ready.directory, 'context.md'), forged);
        await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(manifest));
        await assert.rejects(verifyBundle(ready.directory), /bundleIntegrityFailed/);
      }
      await writeFile(join(ready.directory, 'context.md'), context);
      await writeFile(join(ready.directory, 'manifest.json'), canonicalJSON(ready.manifest));
    } else assert.equal(context.split('<user_instructions date="').length - 1, 1);
    await writeFile(`test-output/packet-datetime-${task ? 'nonempty' : 'empty'}.json`, JSON.stringify({ before, after,
      directory: ready.directory, context: identity(context), manifest: ready.manifest }, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});
