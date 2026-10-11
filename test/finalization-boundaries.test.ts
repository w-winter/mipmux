import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ContextBuildRequest, SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { WorkspaceFailure } from '../src/workspace/values.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const signal = () => new AbortController().signal;
const handoff = { clarifiedTask: 'Advisory', architecture: 'Files', relationships: [], ambiguities: [] };
async function setup() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/finalization-boundary-'));
  const root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root);
  await mkdir(out);
  await writeFile(join(root, 'source.txt'), '\uFEFFsource\r\n');
  await writeFile(join(root, 'local.md'), 'complete local plan');
  const options = {
    cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  };
  const request: ContextBuildRequest = {
    task: 'Task',
    constraints: '',
    enhancementMode: 'augment' as const, purpose: 'investigation',
    requiredSources: [{ kind: 'full', source: { root: 'r', path: 'source.txt' } }],
    documents: [{ kind: 'localDocument', id: 'plan', role: 'plan', source: { root: 'r', path: 'local.md' } }],
    patches: [],
    discoveryHints: [],
    outputName: 'packet',
    allowance: { kind: 'net', method: 'utf8-21-over-80-v1', units: 100000, overheadReserved: true },
  };
  return {
    base,
    root,
    out,
    options,
    request,
    spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out },
  };
}

test('native boundary failures, preclaim cancellation and postclaim runtime closure never misreport publication', async () => {
  for (const scenario of ['cancelBefore', 'cancelAfter', 'writeFailure', 'readbackFailure', 'uncertain'] as const) {
    const f = await setup(), entered = barrier(), resume = barrier();
    let enabled = false;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (
              enabled &&
              (scenario === 'cancelBefore' && operation.kind === 'readExport' ||
                scenario === 'cancelAfter' && operation.kind === 'publishManifest')
            ) {
              enabled = false;
              entered.release();
              await resume.promise;
            }
            if (enabled && scenario === 'writeFailure' && operation.kind === 'writeExport') {
              throw new NativeFailure('nativeIOFailed', 28);
            }
            const reply = await super.request(operation, requestSignal);
            if (enabled && scenario === 'readbackFailure' && reply.result.kind === 'exportRead') {
              return { ...reply, result: { ...reply.result, bytes: Buffer.from('tampered').toString('base64') } };
            }
            if (enabled && scenario === 'uncertain' && operation.kind === 'publishManifest') {
              throw new NativeFailure('publicationUncertain', 5);
            }
            return reply;
          }
        }
        return new Bridge({
          executable: f.options.nativeExecutable,
          env: f.options.nativeEnvironment,
          supervisor: this.supervisor,
        });
      }
    }
    const runtime = new Runtime(f.options);
    try {
      const workspace = await runtime.declare(f.spec, signal()),
        draft = await workspace.createDraft(f.request, signal());
      await draft.update(
        { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } },
        signal(),
      );
      await workspace.close();
      enabled = true;
      const pending = draft.finalize(signal());
      if (scenario === 'cancelAfter') {
        await entered.promise;
        assert.equal(draft.cancelFinalization().kind, 'publicationInProgress');
        const closing = runtime.close();
        resume.release();
        const result = await pending;
        assert.equal(result.kind, 'ready');
        await closing;
        await verifyBundle(join(f.out, 'packet'));
      } else {
        const rejected = assert.rejects(pending);
        if (scenario === 'cancelBefore') {
          await entered.promise;
          assert.equal(draft.cancelFinalization().kind, 'cancelling');
          resume.release();
        }
        await rejected;
        if (scenario === 'uncertain') await verifyBundle(join(f.out, 'packet'));
        else await assert.rejects(readFile(join(f.out, 'packet/manifest.json')));
      }
      await draft.close();
    } finally {
      resume.release();
      await runtime.close();
    }
  }
});

test('integrity is source-independent; current verification detects delivered sources and controls but ignores unrelated edits', async () => {
  const f = await setup(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal()), draft = await workspace.createDraft(f.request, signal());
    await draft.update(
      { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } },
      signal(),
    );
    const result = await draft.finalize(signal());
    if (result.kind !== 'ready') assert.fail('missing bundle');
    await writeFile(join(f.root, 'unselected.txt'), 'unrelated');
    await verifyCurrentBundle(result.directory, runtime, signal());
    await writeFile(join(f.root, 'local.md'), 'changed');
    await verifyBundle(result.directory);
    await assert.rejects(verifyCurrentBundle(result.directory, runtime, signal()));
    await writeFile(join(f.root, 'local.md'), 'complete local plan');
    await writeFile(join(f.root, '.gitignore'), '# new policy');
    await assert.rejects(verifyCurrentBundle(result.directory, runtime, signal()), /policyChanged/);
    await writeFile(join(result.directory, 'context.md'), 'tampered');
    await assert.rejects(verifyBundle(result.directory), /bundleIntegrityFailed/);
    await draft.close();
    await workspace.close();
  } finally {
    await runtime.close();
  }
});

test('claimed publication reports uncertain acknowledgement loss after native sync and definite exclusive refusal', async () => {
  for (const scenario of ['lost', 'malformed', 'refuse'] as const) {
    const f = await setup();
    let enabled = false;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        return enabled ? new BridgeClient({ executable: resolve('test/fixtures/publication-proxy.mjs'), supervisor: this.supervisor,
          env: { ...f.options.nativeEnvironment, PATH: process.env.PATH!, SMIP_NATIVE: f.options.nativeExecutable,
            SMIP_PUBLICATION: scenario, SMIP_MANIFEST: join(f.out, 'packet/manifest.json') } }) : super.makeBridge();
      }
    }
    const runtime = new Runtime(f.options);
    try {
      const workspace = await runtime.declare(f.spec, signal()), draft = await workspace.createDraft(f.request, signal());
      await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify(handoff) } }, signal());
      enabled = true;
      await assert.rejects(draft.finalize(signal()), error => {
        if (scenario === 'refuse') return error instanceof NativeFailure && error.code === 'alreadyExists';
        assert(error instanceof WorkspaceFailure);
        assert.equal(error.code, 'publicationUncertain');
        assert.equal(error.details.code, scenario === 'lost' ? 'nativeWorkerFailed' : 'nativeProtocolError');
        assert.equal(error.details.workerClosed, true);
        return true;
      });
      if (scenario !== 'refuse') await verifyBundle(join(f.out, 'packet'));
      else assert.equal(await readFile(join(f.out, 'packet/manifest.json'), 'utf8'), 'existing completion marker');
      await readFile(join(f.out, 'packet/context.md')); await readFile(join(f.out, 'packet/handoff.md'));
      await writeFile(join(f.base, 'publication-proof.json'), JSON.stringify({ scenario, directory: join(f.out, 'packet'), ready: false }) + '\n');
      await draft.close(); await workspace.close();
    } finally { await runtime.close(); }
  }
});
