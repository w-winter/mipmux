import { join } from 'node:path';
import type { Manifest } from '../contracts/context.js';
import type { AutomaticCodemapOutcome } from '../contracts/automatic-codemaps.js';
import type { RootIdentity } from '../contracts/workspace.js';
import { NativeFailure, NativeWorkerFailure, type BridgeClient } from '../native/bridge-client.js';
import { canonicalJSON, sha256, WorkspaceFailure } from '../workspace/values.js';
import { identity } from './material-store.js';
import type { RenderInput, renderBundle } from './render.js';

type Rendered = ReturnType<typeof renderBundle>;

/** Builds the version-25 manifest for a rendered packet whose automatic codemap outcomes have settled. */
export function bundleManifest(input: RenderInput, rendered: Rendered, automaticCodemaps: readonly AutomaticCodemapOutcome[],
  scope: { readonly exclusions: readonly Manifest['exclusions'][number][]; readonly deniedAbsolutePaths: readonly string[] }): Manifest {
  return {
    schemaVersion: 25,
    manualPresentation: input.manualPresentation,
    codemapMode: input.codemapMode,
    automaticCodemaps: [...automaticCodemaps],
    request: input.request,
    requestDigest: sha256(canonicalJSON(input.request)),
    inventory: input.inventory,
    exclusions: [...scope.exclusions],
    deniedAbsolutePaths: [...scope.deniedAbsolutePaths],
    prompt: input.prompt,
    materials: rendered.records,
    unavailableRoots: [...input.unavailableRoots],
    unavailableFiles: [...input.unavailableFiles],
    clipboardPreset: input.clipboardPreset,
    automaticGit: input.automaticGit === null ? null : { evidence: input.automaticGit.evidence, span: rendered.automaticGitSpan },
    fileTree: { input: input.fileTree.input, span: rendered.fileTreeSpan },
    files: { context: identity(rendered.context), handoff: identity(rendered.handoff) },
    accounting: {
      recipient: 'context.md',
      method: 'utf8-21-over-80-v1',
      bytes: rendered.measurement.bytes,
      units: rendered.measurement.units,
      allowance: rendered.measurement.allowance,
      limitation: 'Heuristic estimate; not an exact token count or provider acceptance guarantee.',
    },
    checks: [
      'source-and-policy-revalidation',
      'complete-delivered-materials',
      'required-source-preservation',
      'explicit-source-omissions',
      'exact-body-spans',
      'actual-packet-accounting',
      'complete-readback',
      'final-input-revalidation',
    ],
    decoder: input.inventory.decoderPolicy,
  };
}

/**
 * Creates `outputName` exclusively beneath the output root, writes and reads back context and handoff, runs
 * `revalidate`, then calls `claim` and publishes the manifest last. Cancellation after the claim cannot revoke the
 * durable write; a lost native acknowledgement becomes publicationUncertain. Returns the bundle directory.
 */
export async function publishBundle(bridge: BridgeClient, output: RootIdentity, outputName: string,
  rendered: Pick<Rendered, 'context' | 'handoff'>, manifest: Manifest, signal: AbortSignal,
  revalidate: () => Promise<void>, claim: () => void): Promise<string> {
  const opened = await bridge.request({
    kind: 'openRoots',
    roots: [{ name: 'output', access: 'output', absolutePath: output.declaredPath, expected: output }],
  }, signal);
  if (!opened.result.roots[0]) {
    throw new WorkspaceFailure('nativeProtocolError');
  }
  const run = await bridge.request({
    kind: 'beginExport',
    root: opened.result.roots[0].handle,
    name: outputName,
  }, signal);
  for (const [filename, text] of [['context.md', rendered.context], ['handoff.md', rendered.handoff]] as const) {
    const bytes = Buffer.from(text);
    await bridge.request(
      { kind: 'writeExport', run: run.result.run, filename, bytes: bytes.toString('base64') },
      signal,
    );
    const read = await bridge.request({ kind: 'readExport', run: run.result.run, filename }, signal);
    if (!Buffer.from(read.result.bytes, 'base64').equals(bytes)) {
      throw new WorkspaceFailure('readbackFailed');
    }
  }
  await revalidate();
  signal.throwIfAborted();
  claim();
  const bytes = Buffer.from(canonicalJSON(manifest) + '\n');
  const published = await bridge.request({
    kind: 'publishManifest',
    run: run.result.run,
    bytes: bytes.toString('base64'),
  }, new AbortController().signal).catch(async error => {
    if (error instanceof NativeWorkerFailure || error instanceof NativeFailure && error.code === 'nativeProtocolError') {
      await bridge.close();
      const receipt = await bridge.closed;
      throw new WorkspaceFailure('publicationUncertain', {
        code: error.code, workerClosed: true, exitCode: receipt.code, signal: receipt.signal,
        spawnFailed: receipt.spawnError !== null,
      });
    }
    throw error;
  });
  if (
    canonicalJSON(published.result.identity) !== canonicalJSON(identity(bytes))
  ) throw new WorkspaceFailure('publicationUncertain');
  return join(output.declaredPath, outputName);
}
