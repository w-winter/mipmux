import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';

async function probe(directory: string, mode: string, scenario: string, component: string) {
  const child = fork(resolve('test/fixtures/bundle-reader-probe.mjs'), [directory, mode, scenario, component], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let boundary = false;
  // This watchdog bounds a failing isolated test, not a production read or a race window.
  const result = await new Promise<Record<string, unknown>>(resolveResult => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolveResult({ kind: 'watchdog', boundary }); }, 3000);
    child.on('message', (message: unknown) => {
      assert(message && typeof message === 'object' && 'kind' in message);
      if (message.kind === 'ready') child.send('go');
      else if (message.kind === 'boundary') {
        boundary = true;
        if (scenario === 'cancel' || scenario === 'shutdown') child.send(scenario);
      } else if (message.kind === 'result') {
        clearTimeout(timer); resolveResult({ ...message, boundary });
      }
    });
  });
  await closed;
  return result;
}

test('saved bundle reader rejects writerless FIFOs and settles cancellation with descriptor cleanup', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/bundle-reader-')), root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out); await writeFile(join(root, 'source.txt'), 'exact source\r\n');
  const runtime = new SmipRuntime({ cachePath: join(base, 'cache'), nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' }, contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 100 });
  const signal = new AbortController().signal;
  const proofs: unknown[] = [];
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out }, signal);
    const draft = await workspace.createDraft({ task: 'Inspect', constraints: '', purpose: 'investigation', requiredSources: [{ kind: 'full', source: { root: 'r', path: 'source.txt' } }],
      documents: [], patches: [], discoveryHints: [], outputName: 'packet', allowance: { kind: 'net', units: 100000, method: 'utf8-21-over-80-v1', overheadReserved: true } }, signal);
    await draft.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'handoff', handoff: {
      clarifiedTask: 'Inspect', architecture: 'Files', relationships: [], ambiguities: [],
    } } }, signal);
    const bundle = await draft.finalize(signal); assert(bundle.kind === 'ready');
    await draft.close(); await workspace.close();
    const directory = bundle.directory;
    for (const component of ['manifest.json', 'context.md', 'handoff.md']) {
      const path = join(directory, component), saved = path + '.saved'; await rename(path, saved);
      try {
        execFileSync('mkfifo', [path]);
        for (const mode of ['integrity', 'current']) proofs.push({ component, mode, scenario: 'fifo', result: await probe(directory, mode, 'fifo', component) });
      } finally { await unlink(path); await rename(saved, path); }
    }
    for (const scenario of ['cancel', 'shutdown', 'readFailure']) proofs.push({ scenario, result: await probe(directory, 'current', scenario, 'context.md') });
    const manifestPath = join(directory, 'manifest.json'), manifest = await readFile(manifestPath);
    try { await writeFile(manifestPath, '{'); proofs.push({ scenario: 'malformed', result: await probe(directory, 'integrity', 'malformed', 'manifest.json') }); }
    finally { await writeFile(manifestPath, manifest); }
    proofs.push({ scenario: 'valid', result: await probe(directory, 'integrity', 'valid', 'manifest.json') });
    await verifyBundle(directory); await verifyCurrentBundle(directory, runtime, signal);
    await writeFile(join(base, 'proof.json'), JSON.stringify({ directory, proofs, validCurrent: true }, null, 2) + '\n');
    for (const proof of proofs) {
      assert(proof && typeof proof === 'object' && 'result' in proof && 'scenario' in proof);
      const result = proof.result; assert(result && typeof result === 'object' && 'kind' in result);
      assert.equal(result.kind, 'result', JSON.stringify(proof));
      assert('closed' in result); assert.equal(result.closed, true);
      assert('opened' in result); assert(Number(result.opened) > 0);
      assert('outcome' in result); const outcome = result.outcome; assert(outcome && typeof outcome === 'object' && 'kind' in outcome);
      assert.equal(outcome.kind, proof.scenario === 'valid' ? 'verified' : 'rejected');
      if (proof.scenario === 'fifo') { assert('code' in outcome); assert.equal(outcome.code, 'nonRegularBundleFile'); }
      if (proof.scenario === 'malformed') { assert('code' in outcome); assert.equal(outcome.code, 'invalidManifest'); }
      if (proof.scenario === 'readFailure') { assert('code' in outcome); assert.equal(outcome.code, 'EIO'); }
      if (proof.scenario === 'cancel' || proof.scenario === 'shutdown') { assert('name' in outcome); assert.equal(outcome.name, 'AbortError'); }
      if (['fifo', 'cancel', 'shutdown', 'readFailure'].includes(String(proof.scenario))) { assert('boundary' in result); assert.equal(result.boundary, true); }
    }
  } finally { await runtime.close(); }
});
