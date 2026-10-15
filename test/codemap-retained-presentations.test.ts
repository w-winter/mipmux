import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, type ContextBuildRequest, type DraftRuntime } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { selectionValidator } from '../src/contracts/selection.js';
import { observe } from '../src/workspace/observe.js';

// RPCE WorkspaceFileContextStore.maximumRetainedCodemapPresentationRecordsPerRoot.
const retainedLimit = 64;
const request: ContextBuildRequest = { task: 'Inspect retained codemaps', constraints: '', enhancementMode: 'preserve',
  purpose: 'investigation', initialSelection: { codemapMode: 'manual', sources: [] }, requiredSources: [],
  documents: [], patches: [], storedPrompts: [], duplicateUserInstructionsAtTop: false, copyPreset: 'standard',
  budgetUnits: 100000, discoveryHints: [], outputName: 'retained-presentation' };
const selection = selectionValidator.Parse(selectionValidator.Default({ op: 'get', view: 'content', maxOutputBytes: 100000 }));

type PresentationBehavior = 'off' | 'hold' | 'fail' | 'retry';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'smip-retained-presentations-')));
  for (const name of ['a', 'b', 'out']) await mkdir(join(base, name));
  for (const name of ['a', 'b']) {
    const type = name === 'a' ? 'FirstRecord' : 'HealthyRecord';
    await writeFile(join(base, name, 'Record.swift'), `struct ${type} { let value: Int }\n`);
    await writeFile(join(base, name, 'Seed.swift'), `struct Seed { let value: ${type} }\n`);
  }
  let behavior: PresentationBehavior = 'off', invalidate = false;
  let entered: (release: () => void) => void = () => { throw new Error('Unexpected presentation'); };
  const gates: (() => void)[] = [];
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (invalidate && operation.kind === 'readSource' && operation.path === 'Record.swift') {
            invalidate = false; throw new NativeFailure('sourceChanged', null);
          }
          return super.request(operation, signal);
        }
      }
      return new Bridge({ executable: this.options.nativeExecutable, env: this.options.nativeEnvironment, supervisor: this.supervisor });
    }
    override async renderPresentation<O extends Extract<NativeOperation, { kind: 'renderFileTree' | 'renderPreparedClipboard' |
      'renderDiscoveryPrompt' | 'renderDiscoveryMessage' | 'renderAutomaticReviewGit' }>>(input: O, signal: AbortSignal) {
      const reply = await super.renderPresentation(input, signal);
      if (behavior === 'off' || input.kind !== 'renderPreparedClipboard' || !input.input.codemapBlocks.some(block => block.includes('FirstRecord'))) return reply;
      if (behavior === 'fail') throw new Error('Injected presentation failure');
      if (behavior === 'retry') { behavior = 'hold'; invalidate = true; return reply; }
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      gates.push(release); entered(release);
      await observe(held, signal);
      return reply;
    }
  }
  const runtime = new Runtime({ cachePath: join(base, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  const calls: Promise<unknown>[] = [];
  const get = (draft: DraftRuntime, signal: AbortSignal) => {
    const call = draft.manageSelection(selection, signal);
    calls.push(call); void call.catch(() => {});
    return call;
  };
  const phase = async (draft: DraftRuntime, signal: AbortSignal) => {
    const entry = new Promise<() => void>(resolve => { entered = resolve; });
    const call = get(draft, signal);
    const result = await Promise.race([entry.then(release => ({ kind: 'held' as const, release })),
      call.then(reply => ({ kind: 'settled' as const, reply }))]);
    return { result, call };
  };
  return { base, runtime, signal, calls, gates, get, phase, setBehavior: (value: PresentationBehavior) => { behavior = value; } };
}

test('retained presentations are bounded per root, including inference, and release on cancellation, failure and retry', async () => {
  const { base, runtime, signal, calls, gates, get, phase, setBehavior } = await fixture();
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'a', absolutePath: join(base, 'a') }, { name: 'b', absolutePath: join(base, 'b') }],
      exclusions: [], outputRoot: join(base, 'out') }, signal);
    const manual = await workspace.createDraft({ ...request,
      requiredSources: [{ kind: 'codemap', source: { root: 'a', path: 'Record.swift' } }] }, signal);
    const partial = await workspace.createDraft({ ...request,
      requiredSources: [{ kind: 'codemap', source: { root: 'a', path: 'Record.swift' } }],
      initialSelection: { codemapMode: 'manual', sources: [{ kind: 'codemap', source: { root: 'b', path: 'Record.swift' } }] } }, signal);
    const automatic = await workspace.createDraft({ ...request, initialSelection: { codemapMode: 'automatic', sources: [] },
      requiredSources: ['a', 'b'].map(root => ({ kind: 'full', source: { root, path: 'Seed.swift' } })) }, signal);
    for (const draft of [manual, partial, automatic]) assert.equal((await get(draft, signal)).measurement.complete, true);
    setBehavior('hold');
    const abort = new AbortController();
    let firstCall!: Promise<unknown>;
    for (let index = 0; index < retainedLimit; index++) {
      const held = await phase(manual, index === 0 ? abort.signal : signal);
      assert.equal(held.result.kind, 'held', 'Source-permitted presentation was not retained');
      if (index === 0) firstCall = held.call;
    }
    const receipts = [];
    for (const draft of [partial, automatic]) {
      const overflow = await phase(draft, signal);
      assert.equal(overflow.result.kind, 'settled', 'A 65th ready presentation escaped root admission');
      if (overflow.result.kind !== 'settled') throw new Error('Unexpected held overflow');
      const reply = overflow.result.reply;
      assert.equal(reply.revision, 0); assert.equal(reply.measurement.complete, false);
      assert.deepEqual(reply.code_structure?.pending_paths, ['a/Record.swift']);
      assert(reply.files.some(file => file.path === 'b/Record.swift' && file.render_mode === 'codemap'));
      assert(!reply.blocks?.some(block => block.includes('FirstRecord {')));
      receipts.push(reply);
    }
    const blocked = await automatic.finalize(signal);
    assert.equal(blocked.kind, 'blocked');
    if (blocked.kind === 'blocked') assert(blocked.diagnostics.some(diagnostic => diagnostic.code === 'codemapPending'));
    const cancelled = assert.rejects(firstCall, /cancelled|aborted/i);
    abort.abort(); await cancelled;
    setBehavior('fail');
    await assert.rejects(get(manual, signal), /Injected presentation failure/);
    setBehavior('retry');
    const retried = await phase(manual, signal);
    assert.equal(retried.result.kind, 'held', 'Stale retry did not release its exact root reservation');
    if (retried.result.kind !== 'held') throw new Error('Unexpected retry completion');
    retried.result.release(); await retried.call;
    setBehavior('off');
    for (const release of gates) release();
    await Promise.allSettled(calls);
    const recovered = await get(automatic, signal);
    assert.equal(recovered.measurement.complete, true); assert.equal(recovered.revision, 0);
    assert.equal(recovered.files.filter(file => file.render_mode === 'codemap').length, 2);
    const finalized = await automatic.finalize(signal);
    assert.equal(finalized.kind, 'ready');
    if (finalized.kind === 'ready') await verifyBundle(finalized.directory);
    await mkdir('test-output', { recursive: true });
    await writeFile('test-output/codemap-retained-presentations-proof.json', JSON.stringify({ retainedLimit, receipts, blocked,
      recovered, finalized, heldCount: gates.length }, null, 2) + '\n');
  } finally {
    setBehavior('off'); for (const release of gates) release();
    await Promise.allSettled(calls); await runtime.close();
  }
});
