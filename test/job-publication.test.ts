import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SmipRuntime, verifyBundle } from '../src/index.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

test('builder cancellation shares the finalizer claim and runtime close waits for publication', async () => {
  for (const afterClaim of [false, true]) {
    let turn = 0, entered!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const provider = await scriptedProvider(() => ++turn === 1 ? { kind: 'tool', name: 'draft_update',
      input: { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'prompt', op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Task', architecture: 'Files', relationships: [], ambiguities: [] }) } }, stop: 'tool_use', tokens: 10 }
      : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
    const root = join(provider.directory, 'root'), output = join(provider.directory, 'out');
    await mkdir(root); await mkdir(output); await writeFile(join(root, 'file.txt'), 'body');
    const options = { nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      nativeEnvironment: {}, contextBudgetUnits: 1000000, credentialPaths: [], cachePath: join(provider.directory, 'cache'), terminationGraceMs: 100 };
    let pause = true;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
            if (pause && operation.kind === (afterClaim ? 'publishManifest' : 'readExport')) {
              pause = false; entered(); await resume;
            }
            return super.request(operation, signal);
          }
        }
        return new Bridge({ executable: options.nativeExecutable, env: {}, supervisor: this.supervisor });
      }
    }
    const runtime = new Runtime(options), signal = new AbortController().signal;
    try {
      const client = runtime.createClient(new PiRunner(provider.config, runtime.supervisor));
      const workspace = await client.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
      const job = client.build(workspace.id, 'one', { task: 'Task', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation',
        requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }], documents: [], patches: [], discoveryHints: [],
        budgetUnits: 10000, outputName: 'packet' });
      await paused;
      const cancellation = client.cancel(job.jobId);
      if (afterClaim) assert('kind' in cancellation && cancellation.kind === 'publicationInProgress');
      const waiting = client.wait(job.jobId, 10000, signal, () => {});
      if (afterClaim) {
        const closing = runtime.close(); release();
        await assert.rejects(waiting, /cancelled/);
        await closing;
        await verifyBundle(join(output, 'packet'));
      } else {
        release(); assert.equal((await waiting).state, 'cancelled');
        await assert.rejects(readFile(join(output, 'packet/manifest.json')));
      }
    } finally { release(); await runtime.close(); await provider.close(); }
  }
});
