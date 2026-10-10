import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { type ContextBuildRequest, type DraftRuntime, SmipRuntime, type RuntimeOptions, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import type { DiscoveryRunner } from '../src/discovery/runner.js';

const signal = () => new AbortController().signal;
const native = resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`);
const rg = process.env.SMIP_TEST_RG ?? resolve('.smip-work/test-ripgrep/ripgrep-e89fff89ac9af12e8d4ce9d5fd07beb408ca730f/target/release/rg');
const handoff = { clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
/** Settles with the work's outcome or 'held' when it has not settled within a bounded unreferenced wait. */
function settles(work: Promise<unknown>): Promise<'settled' | 'held'> {
  return Promise.race([work.then(() => 'settled' as const, () => 'settled' as const), sleep(5000, 'held' as const, { ref: false })]);
}
async function fixture(prefix: string) {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/' + prefix));
  const root = join(base, 'root'), outputRoot = join(base, 'out');
  await mkdir(root); await mkdir(outputRoot);
  await writeFile(join(root, 'model.swift'), 'struct Model {\n let value: String\n}');
  await writeFile(join(root, 'other.txt'), 'independent sibling body\n');
  const options: RuntimeOptions = { cachePath: join(base, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: native, nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' } };
  const request: ContextBuildRequest = { task: 'Task', constraints: '', purpose: 'investigation',
    requiredSources: [{ kind: 'full', source: { root: 'r', path: 'model.swift' } }], documents: [], patches: [], discoveryHints: [],
    outputName: 'packet', allowance: { kind: 'net', method: 'utf8-21-over-80-v1', units: 100000, overheadReserved: true } };
  return { base, root, options, request, spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot } };
}

test('an absent credential beneath an independently symlinked parent stays denied after creation', async () => {
  const f = await fixture('absent-credential-');
  await mkdir(join(f.root, 'config'));
  await writeFile(join(f.root, 'config/public.txt'), 'admitted');
  await symlink(join(f.root, 'config'), join(f.base, 'credential-dir'));
  const credential = join(f.base, 'credential-dir/auth.json');
  const options = { ...f.options, credentialPaths: [credential], search: { executable: rg } };
  const filters = { roots: [], directories: [], include: [], exclude: [], extensions: [] };
  const runtime = new SmipRuntime(options);
  try {
    const handle = await runtime.declare(f.spec, signal());
    const before = await handle.refresh(signal());
    assert.equal(before.enumeration.kind, 'complete');
    assert(!before.entries.some(entry => entry.path === 'config/auth.json'));
    await writeFile(join(f.root, 'config/auth.json'), 'synthetic credential body');
    const after = await handle.refresh(signal());
    assert.equal(after.enumeration.kind, 'complete');
    assert(!after.entries.some(entry => entry.kind === 'file' && entry.path === 'config/auth.json'), 'created credential entered inventory');
    assert(after.entries.some(entry => entry.kind === 'skipped' && entry.path === 'config/auth.json' && entry.reason === 'policy'));
    const operation = await handle.openOperation(signal());
    await assert.rejects(operation.readSource({ root: 'r', path: 'config/auth.json' }), /unavailableSource/);
    await assert.rejects(operation.readComparisonSource({ root: 'r', path: 'config/auth.json' }), /pathDenied/);
    assert.deepEqual(await operation.comparisonFiles('r', null), ['config/public.txt', 'model.swift', 'other.txt']);
    const search = await operation.fileSearch({ mode: 'both', query: { kind: 'literal', text: 'synthetic credential', caseSensitive: true, wholeWord: false },
      filters, before: 0, after: 0, countOnly: false, maxOutputBytes: 10000, continuation: null });
    if (search.kind !== 'search') assert.fail(JSON.stringify(search));
    assert.equal(search.counts.matchedFiles, 0);
    assert.equal((await operation.readSource({ root: 'r', path: 'config/public.txt' })).bytes.toString(), 'admitted');
    const draft = await handle.createDraft({ ...f.request, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'config/public.txt' } }] }, signal());
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff } }, signal());
    const bundle = await draft.finalize(signal());
    if (bundle.kind !== 'ready') assert.fail('missing bundle');
    await operation.close(); await handle.close();
    const unresolvable = f.base + '/credential-dir/missing/../auth.json';
    await symlink(join(f.root, 'config/absent-auth.json'), join(f.base, 'dangling-auth'));
    await symlink(join(f.root, 'absent-config'), join(f.base, 'dangling-dir'));
    const unsafe = [unresolvable, join(f.base, 'dangling-auth'), join(f.base, 'dangling-dir/auth.json')];
    for (const credentialPath of [...unsafe, join(f.base, 'credential-dir/public.txt')]) {
      const verifier = new SmipRuntime({ ...options, credentialPaths: [credentialPath] });
      try {
        const expected = unsafe.includes(credentialPath) ? /credentialPathUnresolvable/ : /policyChanged|pathDenied/;
        await assert.rejects(verifyCurrentBundle(bundle.directory, verifier, signal()), expected);
        if (unsafe.includes(credentialPath)) await assert.rejects(verifier.declare(f.spec, signal()), expected);
      } finally { await verifier.close(); }
    }
    await writeFile(join(f.base, 'absent-credential-proof.json'), JSON.stringify({ credential, skipped: after.entries.filter(entry => entry.path === 'config/auth.json') }) + '\n');
  } finally { await runtime.close(); }
});

test('draft admission uses its qualifying refresh snapshot while a later scan is held, fails or is unrelated to cancellation', async () => {
  for (const mode of ['manual', 'builder', 'cancel'] as const) {
    const f = await fixture('admission-' + mode + '-');
    const secondEntered = barrier(), secondResume = barrier(), thirdEntered = barrier(), thirdResume = barrier();
    let lists = 0;
    const held: { signal: AbortSignal | null } = { signal: null };
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (operation.kind === 'listDirectory') {
              lists++;
              if (lists === 2) { secondEntered.release(); await secondResume.promise; }
              if (lists === 3) {
                held.signal = requestSignal; thirdEntered.release(); await thirdResume.promise;
                if (mode !== 'cancel') await this.close();
              }
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({ executable: f.options.nativeExecutable, env: f.options.nativeEnvironment, supervisor: this.supervisor });
      }
    }
    const runtime = new Runtime(f.options);
    const runnerEntered = barrier();
    const runner: DiscoveryRunner = { run: async () => { runnerEntered.release(); throw new Error('scripted stop after admission'); } };
    const client = runtime.createClient(runner);
    try {
      const workspace = await client.declare(f.spec, signal());
      const handle = await runtime.declare(f.spec, signal());
      let admission: Promise<unknown>, jobId: string | null = null;
      if (mode === 'manual') admission = handle.createDraft(f.request, signal());
      else {
        const job = client.build(workspace.id, 'one', f.request);
        jobId = job.jobId;
        admission = client.wait(jobId, 20000, signal(), progress => {
          if (mode === 'cancel' && progress.state === 'acquiringMaterials') client.cancel(job.jobId);
        });
      }
      void admission.catch(() => {});
      await secondEntered.promise;
      const later = handle.refresh(signal());
      void later.catch(() => {});
      secondResume.release();
      await thirdEntered.promise;
      assert.equal(await settles(admission), 'settled', mode + ': admission waited for an unrelated later scan');
      if (mode === 'manual') {
        const draft = await (admission as Promise<DraftRuntime>);
        assert.equal(draft.operation.snapshot.generation, 2);
        await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff } }, signal());
        assert.equal((await draft.validate(signal())).kind, 'validation');
        await draft.close();
      } else {
        const snapshot = client.result(jobId!);
        assert.equal(snapshot.state, mode === 'cancel' ? 'cancelled' : 'failed');
        if (mode === 'builder') await runnerEntered.promise;
        assert.equal(held.signal?.aborted, false, 'unrelated held scan must not be cancelled');
      }
      thirdResume.release();
      if (mode === 'cancel') assert.equal((await later).generation, 3);
      else await assert.rejects(later, /nativeWorkerClosed/);
      await handle.close(); await client.close();
    } finally { secondResume.release(); thirdResume.release(); await runtime.close(); }
  }
});

test('terminal manual finalization releases the workspace lease while blocked drafts stay editable and leased', async () => {
  for (const scenario of ['stale', 'cancel', 'publication'] as const) {
    const f = await fixture('terminal-lease-' + scenario + '-');
    const bridges: BridgeClient[] = [], entered = barrier(), resume = barrier();
    let hold = false, fail = false;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (hold && operation.kind === 'readExport') { hold = false; entered.release(); await resume.promise; }
            if (fail && operation.kind === 'publishManifest') { fail = false; throw new NativeFailure('nativeIOFailed', 28); }
            return super.request(operation, requestSignal);
          }
        }
        const bridge = new Bridge({ executable: f.options.nativeExecutable, env: f.options.nativeEnvironment, supervisor: this.supervisor });
        bridges.push(bridge);
        return bridge;
      }
    }
    const runtime = new Runtime(f.options), client = runtime.createClient(null);
    try {
      const workspace = await client.declare(f.spec, signal());
      const ownerBridge = bridges[0];
      assert(ownerBridge);
      const siblingRoot = join(f.base, 'sibling-root'), siblingOutput = join(f.base, 'sibling-out');
      await mkdir(siblingRoot); await mkdir(siblingOutput);
      await writeFile(join(siblingRoot, 'other.txt'), 'unrelated owner body\n');
      const siblingWorkspace = await client.declare({ ...f.spec, roots: [{ name: 'r', absolutePath: siblingRoot }], outputRoot: siblingOutput }, signal());
      const sibling = await client.createDraft(siblingWorkspace.id, { ...f.request, outputName: 'sibling',
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'other.txt' } }] }, signal());
      await client.closeWorkspace(siblingWorkspace.id);
      const draft = await client.createDraft(workspace.id, f.request, signal());
      assert.equal((await client.finalize(draft.id, signal())).kind, 'blocked');
      const edited = await client.update(draft.id, { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff } }, signal());
      assert.equal(edited.revision, 1, 'a blocked draft remains editable');
      await client.closeWorkspace(workspace.id);
      if (scenario === 'stale') {
        await writeFile(join(f.root, 'model.swift'), 'struct Changed {}');
        await assert.rejects(client.finalize(draft.id, signal()), /sourceChanged/);
      } else if (scenario === 'cancel') {
        hold = true;
        const abort = new AbortController(), rejected = assert.rejects(client.finalize(draft.id, abort.signal), /cancelled/);
        await entered.promise; abort.abort(); resume.release(); await rejected;
      } else {
        fail = true;
        await assert.rejects(client.finalize(draft.id, signal()), /nativeIOFailed/);
        await readFile(join(f.spec.outputRoot, 'packet/context.md')); await readFile(join(f.spec.outputRoot, 'packet/handoff.md'));
      }
      const metadata = client.inspect(draft.id, { view: 'metadata', continuation: null, maxOutputBytes: 10000 });
      assert(metadata.kind === 'metadata' && metadata.state === 'terminal' && metadata.revision === 1);
      await assert.rejects(client.update(draft.id, { expectedRevision: 1, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff } }, signal()), /draftFrozen|cancelled/);
      const owner = await Promise.race([ownerBridge.closed.then(() => 'closed' as const), sleep(5000, 'retained' as const, { ref: false })]);
      assert.equal(owner, 'closed', scenario + ': a terminal draft retained the workspace lease');
      await client.update(sibling.id, { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff } }, signal());
      const validation = JSON.parse(JSON.stringify(await client.validate(sibling.id, 10000, signal())));
      assert.equal(validation.kind, 'validation');
      assert.equal((await client.finalize(sibling.id, signal())).kind, 'ready');
      await Promise.all(bridges.map(bridge => bridge.closed));
      await writeFile(join(f.base, 'terminal-lease-proof.json'), JSON.stringify({ scenario, bridges: bridges.length, owner }) + '\n');
      await client.close();
    } finally { resume.release(); await runtime.close(); }
  }
});
