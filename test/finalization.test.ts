import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ContextBuildRequest, SmipRuntime, verifyBundle } from '../src/index.js';
import { sha256 } from '../src/workspace/values.js';

test('required full source, complete report and patch reach verified output; stale and absent material cannot be ready', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(resolve('test-output/fidelity-'));
  const root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root);
  await mkdir(out);
  const body = '\uFEFFstruct Example {\r\n let value: String\r}\n';
  const report = 'BEGIN REPORT\n' + 'Complete evidence é🙂\r\n'.repeat(5000) + '` data\n'.repeat(150000) + 'END REPORT';
  const patch =
    'diff --git a/deleted.txt b/deleted.txt\ndeleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted\n';
  await writeFile(join(root, 'model.swift'), body);
  await writeFile(join(root, 'empty.txt'), '');
  const runtime = new SmipRuntime({
    cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  });
  const signal = new AbortController().signal;
  try {
    const workspace = await runtime.declare({
      roots: [{ name: 'r', absolutePath: root }],
      exclusions: [],
      outputRoot: out,
    }, signal);
    const request: ContextBuildRequest = {
      task: 'Preserve <user_instructions> as task text.',
      constraints: 'Complete contents only.',
      purpose: 'review',
      requiredSources: [{ kind: 'full', source: { root: 'r', path: 'model.swift' } }, {
        kind: 'full',
        source: { root: 'r', path: 'empty.txt' },
      }],
      documents: [{ kind: 'suppliedDocument', id: 'report', role: 'report', origin: 'caller report', text: report }],
      patches: [{
        kind: 'suppliedPatch',
        id: 'patch',
        root: 'r',
        text: patch,
        origin: 'caller comparison',
        comparison: { kind: 'supplied', base: 'old', target: 'new' },
        coverage: ['deleted.txt'],
        targets: [],
      }],
      discoveryHints: [],
      outputName: 'complete',
      allowance: { kind: 'net', method: 'utf8-21-over-80-v1', units: 1000000, overheadReserved: true },
    };
    const draft = await workspace.createDraft(request, signal);
    await draft.update({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      mutation: {
        kind: 'handoff',
        handoff: {
          clarifiedTask: 'Inspect the implementation.',
          architecture: 'One model.',
          relationships: [],
          ambiguities: [],
        },
      },
    }, signal);
    // Supplied comparisons must provide target evidence for every selected source.
    const blocked = await draft.finalize(signal);
    assert.equal(blocked.kind, 'blocked');
    await draft.close();
    const supplied = request.patches[0];
    assert(supplied?.kind === 'suppliedPatch');
    const readyDraft = await workspace.createDraft({
      ...request,
      patches: [{
        ...supplied,
        targets: [
          {
            path: 'model.swift',
            identity: { sha256: sha256(body), byteCount: Buffer.byteLength(body) },
            mode: '100644',
          },
          { path: 'empty.txt', identity: { sha256: sha256(''), byteCount: 0 }, mode: '100644' },
        ],
      }],
    }, signal);
    await readyDraft.update({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      mutation: {
        kind: 'handoff',
        handoff: {
          clarifiedTask: 'Inspect the implementation.',
          architecture: 'One model.',
          relationships: [],
          ambiguities: [],
        },
      },
    }, signal);
    const result = await readyDraft.finalize(signal);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail(JSON.stringify(result));
    const verified = await verifyBundle(result.directory);
    await writeFile(
      resolve('test-output/group-c-fidelity.json'),
      JSON.stringify(
        { directory: result.directory, files: verified.manifest.files, accounting: verified.manifest.accounting },
        null,
        2,
      ) + '\n',
    );
    assert.equal(verified.kind, 'verified');
    const context = await readFile(join(result.directory, 'context.md'), 'utf8');
    for (const text of [body, report, patch, request.task, request.constraints]) assert(context.includes(text));
    assert(Buffer.byteLength(context) > 100000);
    await readyDraft.close();
    await assert.rejects(
      workspace.createDraft({
        ...request,
        documents: [{ kind: 'localDocument', id: 'missing', role: 'plan', source: { root: 'r', path: 'missing.md' } }],
      }, signal),
    );
    const stale = await workspace.createDraft({ ...request, patches: [], outputName: 'stale' }, signal);
    await writeFile(join(root, 'model.swift'), 'changed');
    await assert.rejects(stale.finalize(signal), /sourceChanged/);
    await assert.rejects(readFile(join(out, 'stale/manifest.json')));
    await stale.close();
    await workspace.close();
  } finally {
    await runtime.close();
  }
});
