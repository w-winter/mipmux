import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { NativeHandle } from '../src/contracts/native.js';
import type { SourceIdentity } from '../src/contracts/workspace.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

const executable = resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`);
const mebibyte = 1024 * 1024;
// One large frame is timed against `parts` frames of 1/parts its size, sent back to back in the same process, so machine
// speed cancels. Linear framing keeps the ratio near 1; the quadratic framing this guards against measured 7 to 35.
const parts = 32;
const maximumRatio = 3;
const signal = () => new AbortController().signal;
const identity = (bytes: Buffer): SourceIdentity => ({ sha256: createHash('sha256').update(bytes).digest('hex'), byteCount: bytes.length });

interface Scaling {
  /** Sends the next calibration request and returns the identity the helper reports. */
  readonly small: () => Promise<SourceIdentity>;
  /** Sends the large request under `signal` and returns the identity the helper reports. */
  readonly large: (signal: AbortSignal) => Promise<SourceIdentity>;
  /** The identity the large request must report. */
  readonly expected: SourceIdentity;
}

/**
 * Times `parts` small requests, then the large request, which is cancelled once it takes `maximumRatio` times their sum.
 * Records the times in test-output/<name>-proof.json before asserting the bound and the reported identity.
 */
async function assertLinear(name: string, sizes: { readonly smallMiB: number; readonly largeMiB: number },
  prepare: (bridge: BridgeClient, root: NativeHandle, directory: string) => Promise<Scaling>): Promise<void> {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable, supervisor, env: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  const directory = await mkdtemp(join(tmpdir(), 'mipmux-frame-scaling-'));
  try {
    const [output] = (await bridge.request({ kind: 'openRoots',
      roots: [{ name: 'output', absolutePath: directory, access: 'output', expected: null }] }, signal())).result.roots;
    assert(output);
    const scaling = await prepare(bridge, output.handle, directory);
    let calibrationMs = 0;
    for (let part = 0; part < parts; part++) {
      const started = performance.now();
      await scaling.small();
      calibrationMs += performance.now() - started;
    }
    const boundMs = Math.ceil(maximumRatio * calibrationMs);
    let reported: SourceIdentity | null = null, largeMs: number | null = null;
    const started = performance.now();
    try {
      reported = await scaling.large(AbortSignal.timeout(boundMs));
      largeMs = performance.now() - started;
    } catch (error) {
      if (!(error instanceof NativeFailure && error.code === 'cancelled')) throw error;
    }
    const proof = { platform: process.platform, arch: process.arch, node: process.version, ...sizes, parts,
      largeBase64Bytes: Math.ceil(sizes.largeMiB * mebibyte / 3) * 4, calibrationMs, largeMs, boundMs,
      ratio: largeMs === null ? null : largeMs / calibrationMs };
    await mkdir('test-output', { recursive: true });
    await writeFile(`test-output/${name}-proof.json`, JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof));
    assert(largeMs !== null && largeMs <= boundMs, `The ${sizes.largeMiB} MiB request took ` +
      `${largeMs === null ? 'over ' + boundMs : Math.round(largeMs)} ms, more than ${boundMs} ms, ${maximumRatio} times the ` +
      `${Math.round(calibrationMs)} ms of ${parts} requests of ${sizes.smallMiB} MiB`);
    assert.deepEqual(reported, scaling.expected);
  } finally {
    await bridge.close(); await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('a request frame is read in time linear in its size', async () => {
  const sizes = { smallMiB: 1, largeMiB: 32 };
  await assertLinear('native-request-frame-scaling', sizes, async (bridge, root) => {
    const begin = async (name: string) => (await bridge.request({ kind: 'beginExport', root, name }, signal())).result.run;
    const runs: NativeHandle[] = [];
    for (let part = 0; part < parts; part++) runs.push(await begin('small-' + part));
    const largeRun = await begin('large');
    const write = async (run: NativeHandle, bytes: string, abort: AbortSignal) =>
      (await bridge.request({ kind: 'writeExport', run, filename: 'context.md', bytes }, abort)).result.identity;
    const small = Buffer.alloc(sizes.smallMiB * mebibyte, 'x').toString('base64');
    const large = Buffer.alloc(sizes.largeMiB * mebibyte, 'x');
    const encoded = large.toString('base64');
    return {
      small: () => {
        const run = runs.shift();
        assert(run);
        return write(run, small, signal());
      },
      large: abort => write(largeRun, encoded, abort),
      expected: identity(large),
    };
  });
});

test('a reply frame is read in time linear in its size', async () => {
  const sizes = { smallMiB: 4, largeMiB: 128 };
  await assertLinear('native-reply-frame-scaling', sizes, async (bridge, root, directory) => {
    const begin = async (name: string) => (await bridge.request({ kind: 'beginExport', root, name }, signal())).result.run;
    const smallRun = await begin('small'), largeRun = await begin('large');
    // Written directly, so that this test does not depend on request framing.
    await writeFile(join(directory, 'small', 'context.md'), Buffer.alloc(sizes.smallMiB * mebibyte, 'x'));
    const large = Buffer.alloc(sizes.largeMiB * mebibyte, 'x');
    await writeFile(join(directory, 'large', 'context.md'), large);
    const read = async (run: NativeHandle, abort: AbortSignal) =>
      (await bridge.request({ kind: 'readExport', run, filename: 'context.md' }, abort)).result.identity;
    return { small: () => read(smallRun, signal()), large: abort => read(largeRun, abort), expected: identity(large) };
  });
});
