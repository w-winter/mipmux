import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { chmod, readFile, mkdir, mkdtemp, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { type ContextBuildRequest, MipmuxRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { BridgeClient, NativeFailure } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

const signal = () => new AbortController().signal;
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

test('current verification admits only recorded material, applies current denies, and checks fresh native keys and root aliases', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-current-'));
  const root = join(base, 'source'), out = join(base, 'out'), alias = join(base, 'alias');
  await mkdir(root);
  await mkdir(out);
  await symlink(root, alias);
  await mkdir(join(root, 'unrelated'));
  await writeFile(join(root, 'unrelated/private.txt'), 'not selected');
  await writeFile(join(root, 'model.swift'), 'struct Example {\n let title: String\n}\n');
  const options = {
    copyContext: copyContext(), cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  };
  const request: ContextBuildRequest = {
    task: 'Review',
    initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '',
    enhancementMode: 'augment' as const, purpose: 'review',
    requiredSources: [{ kind: 'codemap', source: { root: 'r', path: 'model.swift' } }],
    documents: [],
    patches: [],
    discoveryHints: [],
    outputName: 'packet',
    budgetUnits: 100000,
  };
  const writer = new MipmuxRuntime(options);
  try {
    const workspace = await writer.declare({
      roots: [{ name: 'r', absolutePath: alias }],
      exclusions: [],
      outputRoot: out,
    }, signal());
    const draft = await workspace.createDraft(request, signal());
    await draft.prompt({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Review', architecture: 'Model', relationships: [], ambiguities: [] }) ,
    }, signal());
    const result = await draft.finalize(signal());
    if (result.kind !== 'ready') assert.fail('missing bundle');
    const manifestPath = join(result.directory, 'manifest.json');
    const savedManifest = await readFile(manifestPath, 'utf8');
    try {
      for (const change of ['key', 'exclusion']) {
        const malformed = JSON.parse(savedManifest);
        if (change === 'key') malformed.materials[0].artifactKey.canonicalBase64 = '@';
        else malformed.exclusions = [{ kind: 'prefix', root: 'bad root', path: '../escape' }];
        await writeFile(manifestPath, JSON.stringify(malformed));
        await assert.rejects(verifyBundle(result.directory), /invalidManifest/);
      }
    } finally { await writeFile(manifestPath, savedManifest); }
    await verifyBundle(result.directory);
    const originalMode = (await stat(join(root, 'model.swift'))).mode;
    const modeDraft = await workspace.createDraft({ ...request, outputName: 'mode-change' }, signal());
    await modeDraft.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify({
      clarifiedTask: 'Review', architecture: 'Model', relationships: [], ambiguities: [],
    })  }, signal());
    await chmod(join(root, 'model.swift'), originalMode ^ 0o100);
    await assert.rejects(modeDraft.finalize(signal()), /sourceChanged/);
    await assert.rejects(readFile(join(out, 'mode-change/manifest.json')));
    await chmod(join(root, 'model.swift'), originalMode);
    await modeDraft.close();
    await draft.close();
    await workspace.close();
    await chmod(join(root, 'unrelated'), 0);
    let enumeration = 0;
    class VerificationRuntime extends MipmuxRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
            if (operation.kind === 'listDirectory') {
              enumeration++;
              if (operation.directory.kind === 'descendant' && operation.directory.path === 'unrelated') {
                throw new NativeFailure('permissionDenied', 13);
              }
            }
            return super.request(operation, requestSignal);
          }
        }
        return new Bridge({
          executable: options.nativeExecutable,
          env: options.nativeEnvironment,
          supervisor: this.supervisor,
        });
      }
    }
    const verifier = new VerificationRuntime(options);
    try {
      await verifyCurrentBundle(result.directory, verifier, signal());
      assert.equal(enumeration, 0);
    } finally {
      await verifier.close();
    }
    const credentialAlias = join(base, 'credential-alias');
    await symlink(join(root, 'model.swift'), credentialAlias);
    for (const credentialPath of [join(root, 'model.swift'), join(alias, 'model.swift'), credentialAlias]) {
      const denied = new MipmuxRuntime({ ...options, credentialPaths: [credentialPath] });
      try {
        await assert.rejects(verifyCurrentBundle(result.directory, denied, signal()), /policyChanged|pathDenied/);
      } finally {
        await denied.close();
      }
    }
    const pipeline = new MipmuxRuntime({ ...options, nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'required' } });
    try {
      await assert.rejects(verifyCurrentBundle(result.directory, pipeline, signal()), /pipelineChanged/);
    } finally {
      await pipeline.close();
    }
    await verifyBundle(result.directory);
    await mkdir(join(base, 'replacement'));
    await unlink(alias);
    await symlink(join(base, 'replacement'), alias);
    await assert.rejects(verifyCurrentBundle(result.directory, writer, signal()), /rootChanged/);
    await verifyBundle(result.directory);
  } finally {
    await chmod(join(root, 'unrelated'), 0o700);
    await writer.close();
  }
});

test('current verification cancellation and runtime shutdown join native work and reject further admission', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-current-cancel-'));
  const root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root);
  await mkdir(out);
  await writeFile(join(root, 'file.txt'), 'body');
  const options = {
    copyContext: copyContext(), cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  };
  const writer = new MipmuxRuntime(options);
  const request: ContextBuildRequest = {
    task: 'Review',
    initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '',
    enhancementMode: 'augment' as const, purpose: 'review',
    requiredSources: [{ kind: 'full', source: { root: 'r', path: 'file.txt' } }],
    documents: [],
    patches: [],
    discoveryHints: [],
    outputName: 'packet',
    budgetUnits: 100000,
  };
  try {
    const workspace = await writer.declare({
        roots: [{ name: 'r', absolutePath: root }],
        exclusions: [],
        outputRoot: out,
      }, signal()),
      draft = await workspace.createDraft(request, signal());
    await draft.prompt({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      op: 'append', text: '\n\n' + JSON.stringify({ clarifiedTask: 'Review', architecture: 'Files', relationships: [], ambiguities: [] }) ,
    }, signal());
    const result = await draft.finalize(signal());
    if (result.kind !== 'ready') assert.fail('missing bundle');
    await draft.close();
    await workspace.close();
    for (const shutdown of [false, true]) {
      const entered = barrier(), resume = barrier();
      let pause = true;
      class Runtime extends MipmuxRuntime {
        override makeBridge() {
          class Bridge extends BridgeClient {
            override async request<O extends NativeOperation>(operation: O, requestSignal: AbortSignal) {
              if (pause && operation.kind === 'openRoots') {
                pause = false;
                entered.release();
                await resume.promise;
              }
              return super.request(operation, requestSignal);
            }
          }
          return new Bridge({
            executable: options.nativeExecutable,
            env: options.nativeEnvironment,
            supervisor: this.supervisor,
          });
        }
      }
      const runtime = new Runtime(options), abort = new AbortController();
      const pending = verifyCurrentBundle(result.directory, runtime, abort.signal), rejected = assert.rejects(pending);
      await entered.promise;
      const closing = shutdown ? runtime.close() : null;
      if (!shutdown) abort.abort();
      resume.release();
      await rejected;
      await closing;
      await runtime.close();
      await assert.rejects(verifyCurrentBundle(result.directory, runtime, signal()), /runtimeClosed/);
    }
  } finally {
    await writer.close();
  }
});
