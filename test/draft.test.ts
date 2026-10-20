import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import { type ContextBuildRequest, SmipRuntime, verifyBundle } from '../src/index.js';
import { estimateUnits } from '../src/context/budget.js';
import { normalizeRanges } from '../src/context/material-store.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import type { NativeOperation } from '../src/contracts/native.js';

const signal = () => new AbortController().signal;
const handoff = {
  clarifiedTask: 'Clarification',
  architecture: 'Architecture',
  relationships: ['A uses B'],
  ambiguities: [],
};
const request: ContextBuildRequest = {
  task: 'Original task',
  initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, constraints: '',
  enhancementMode: 'augment' as const, purpose: 'planning',
  requiredSources: [],
  documents: [],
  patches: [],
  discoveryHints: [],
  outputName: 'packet',
  budgetUnits: 1000000,
};
async function fixture() {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'smip-draft-'));
  await mkdir(join(base, 'root'));
  await mkdir(join(base, 'out'));
  await writeFile(join(base, 'root/a.swift'), 'struct Alpha {\r\n let value: String\r}\n');
  await writeFile(join(base, 'root/b.txt'), 'first\nsecond\nthird');
  await writeFile(join(base, 'root/binary.swift'), Buffer.from([0xff, 0xfe, 0x00, 0xd8]));
  const options = {
    copyContext: copyContext(), cachePath: join(base, 'cache'),
    terminationGraceMs: 100,
    contextBudgetUnits: 1000000, credentialPaths: [],
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
    nativeEnvironment: { REPOPROMPT_PCRE2_JIT: 'disabled' },
  };
  return {
    base,
    options,
    spec: { roots: [{ name: 'r', absolutePath: join(base, 'root') }], exclusions: [], outputRoot: join(base, 'out') },
  };
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

test('curated documents reject duplicates, invalid text, stale revisions and cancelled or oversized updates without partial commits', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const original = { kind: 'suppliedDocument' as const, id: 'original', role: 'report' as const, origin: 'caller', text: 'Original document' };
    const draft = await workspace.createDraft({ ...request, documents: [original] }, signal());
    const document = { kind: 'suppliedDocument' as const, id: 'fetched', role: 'evidence' as const, origin: '/never/read', text: '\uFEFFNew evidence\r\nComplete 🙂' };
    const mutation = { kind: 'addDocument' as const, document };
    const input = { expectedRevision: 0, maxOutputBytes: 10000, mutation };
    await assert.rejects(draft.update({ ...input, mutation: { ...mutation, document: { ...document, id: original.id } } }, signal()), /duplicateMaterial/);
    for (const invalid of [{ ...document, text: '\ud800' }, { ...document, text: 'NUL\0text' }, { ...document, origin: '\ud800' }]) {
      await assert.rejects(draft.update({ ...input, mutation: { ...mutation, document: invalid } }, signal()), /invalidEncoding/);
    }
    await assert.rejects(draft.update({ ...input, maxOutputBytes: 1 }, signal()), /outputBudgetTooSmall/);
    const abort = new AbortController(), pending = draft.update(input, abort.signal);
    abort.abort(); await assert.rejects(pending, /cancelled/);
    assert.equal(draft.revision, 0);
    const competingDocument = { ...document, id: 'competing' };
    const first = draft.update(input, signal());
    const competing = draft.update({ ...input, mutation: { ...mutation, document: competingDocument } }, signal());
    const results = await Promise.allSettled([first, competing]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert(rejected?.status === 'rejected'); assert.match(String(rejected.reason), /revisionConflict/);
    const winner = results[0]?.status === 'fulfilled' ? document : competingDocument;
    const loser = results[0]?.status === 'fulfilled' ? competingDocument : document;
    assert.equal(draft.revision, 1);
    await assert.rejects(draft.update(input, signal()), /revisionConflict/);
    await assert.rejects(draft.update({ ...input, expectedRevision: 1, mutation: { ...mutation, document: winner } }, signal()), /duplicateMaterial/);
    await assert.rejects(async () => (await draft.inspect({ view: 'material', materialId: 'document:' + loser.id, continuation: null, maxOutputBytes: 10000 }, new AbortController().signal)), /materialUnavailable/);
    for (const expected of [original, winner]) {
      const page = (await draft.inspect({ view: 'material', materialId: 'document:' + expected.id, continuation: null, maxOutputBytes: 10000 }, new AbortController().signal));
      assert(page.kind === 'material'); assert.equal(page.lines.map(line => line.text).join(''), expected.text);
    }
    assert.deepEqual(draft.request.documents, [original]);
    await writeFile(join(f.base, 'curated-document-admission-proof.json'), JSON.stringify({ results, revision: draft.revision,
      inspection: (await draft.inspect({ view: 'metadata', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal)) }, null, 2));
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});

test('complete documents added during curation count toward the recipient allowance and block oversized publication', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft({ ...request, outputName: 'oversized-document',
      budgetUnits: 1000 }, signal());
    await draft.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  }, signal());
    const text = 'Complete fetched document\r\n'.repeat(1000);
    const update = await draft.update({ expectedRevision: 1, maxOutputBytes: 10000,
      mutation: { kind: 'addDocument', document: { kind: 'suppliedDocument', id: 'large', role: 'evidence', origin: 'fixture', text } } }, signal());
    assert(update.diagnostics.some(diagnostic => diagnostic.code === 'overBudget')); assert.equal(update.revision, 2);
    const validation = await draft.validate(signal());
    assert(validation.costs.some(cost => cost.id === 'document:large' && cost.units > 1000));
    const result = await draft.finalize(signal()); assert.equal(result.kind, 'blocked');
    await assert.rejects(access(join(f.base, 'out/oversized-document')), { code: 'ENOENT' });
    await writeFile(join(f.base, 'curated-document-budget-proof.json'), JSON.stringify({ update, validation, result }, null, 2));
    await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});

test('drafts isolate revisioned mutations, required contents, budgets, inspection, and deterministic representations', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const a = await workspace.createDraft(request, signal()), b = await workspace.createDraft(request, signal());
    const slices = {
      kind: 'slices' as const,
      source: { root: 'r', path: 'b.txt' },
      ranges: [
        { start: 2, end: 3, description: 'end' },
        { start: 1, end: 2, description: 'start' },
      ],
    };
    const changes = [{ kind: 'upsert' as const, selection: slices }, {
      kind: 'upsert' as const,
      selection: { kind: 'codemap' as const, source: { root: 'r', path: 'a.swift' } },
    }];
    for (const [index, mutation] of changes.entries()) {
      await a.update({ expectedRevision: index, maxOutputBytes: 10000, mutation }, signal());
    }
    await a.prompt({ expectedRevision: 2, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff) }, signal());
    await b.prompt({ expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff) }, signal());
    for (const [index, mutation] of [...changes].reverse().entries()) {
      await b.update({ expectedRevision: index + 1, maxOutputBytes: 10000, mutation }, signal());
    }
    assert.deepEqual((await a.validate(signal())).measurement, (await b.validate(signal())).measurement);
    assert.equal(a.revision, 3);
    assert.equal(b.revision, 3);
    await assert.rejects(
      a.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation: changes[0]! }, signal()),
      /revisionConflict/,
    );
    await a.update({ expectedRevision: 3, maxOutputBytes: 10000, mutation: changes[0]! }, signal());
    assert.equal(a.revision, 3);
    await assert.rejects(
      a.prompt({
        expectedRevision: 3,
        maxOutputBytes: 1,
        op: 'append', text: '\n\n' + JSON.stringify({ ...handoff, architecture: 'changed' }) ,
      }, signal()),
      /outputBudgetTooSmall/,
    );
    assert.equal(a.revision, 3);
    for (
      const ranges of [[], [{ start: 0, end: 1, description: '' }], [{ start: 2, end: 1, description: '' }], [{
        start: 1,
        end: 99,
        description: '',
      }]]
    ) {
      await assert.rejects(
        a.update({
          expectedRevision: 3,
          maxOutputBytes: 10000,
          mutation: { kind: 'upsert', selection: { ...slices, ranges } },
        }, signal()),
      );
    }
    const result = await a.finalize(signal());
    assert.equal(result.kind, 'ready');
    await rename(join(f.base, 'out/packet'), join(f.base, 'out/first'));
    const second = await b.finalize(signal());
    assert.equal(second.kind, 'ready');
    for (const name of ['context.md', 'handoff.md', 'manifest.json']) {
      assert.deepEqual(
        await readFile(join(f.base, 'out/first', name)),
        await readFile(join(f.base, 'out/packet', name)),
      );
    }
    await a.close();
    await b.close();
    const limited = await workspace.createDraft({
      ...request,
      outputName: 'limited',
      budgetUnits: 1,
    }, signal());
    await limited.prompt(
      { expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  },
      signal(),
    );
    assert.equal((await limited.finalize(signal())).kind, 'blocked');
    await limited.prompt({
      expectedRevision: 1,
      maxOutputBytes: 10000,
      op: 'append', text: '\n\n' + JSON.stringify({ ...handoff, clarifiedTask: 'short' }) ,
    }, signal());
    await limited.close();
    const required = await workspace.createDraft({
      ...request,
      requiredSources: [{ kind: 'full', source: slices.source }],
      documents: [
        { kind: 'suppliedDocument', id: 'report', role: 'report', text: 'one\ntwo\nthree', origin: '/never/open' },
      ],
    }, signal());
    await assert.rejects(
      required.update({
        expectedRevision: 0,
        maxOutputBytes: 10000,
        mutation: { kind: 'remove', source: slices.source },
      }, signal()),
      /requiredMaterialMutation/,
    );
    await assert.rejects(
      required.update(
        { expectedRevision: 0, maxOutputBytes: 10000, mutation: { kind: 'upsert', selection: slices } },
        signal(),
      ),
      /requiredMaterialMutation/,
    );
    const content = await required.inspect({
      view: 'material',
      materialId: 'document:report',
      maxOutputBytes: 10000,
      continuation: null,
    }, new AbortController().signal);
    assert.equal(content.kind, 'material');
    if (content.kind !== 'material') assert.fail('Missing material');
    const cap = Buffer.byteLength(
      JSON.stringify({
        ...content,
        lines: content.lines.slice(0, 1),
        truncated: true,
        continuation: { digest: content.digest, offset: 1 },
      }),
    );
    let continuation: null | { digest: string; offset: number } = null;
    const texts: string[] = [];
    do {
      const page = (await required.inspect({
        view: 'material',
        materialId: 'document:report',
        maxOutputBytes: cap,
        continuation,
      }, new AbortController().signal));
      if (page.kind !== 'material') assert.fail('Missing material page');
      assert(Buffer.byteLength(JSON.stringify(page)) <= cap);
      texts.push(...page.lines.map((line) => line.text));
      continuation = page.continuation;
    } while (continuation);
    assert.equal(texts.join(''), 'one\ntwo\nthree');
    await required.close();
    await assert.rejects(
      workspace.createDraft({
        ...request,
        documents: [{ kind: 'suppliedDocument', id: 'invalid', role: 'plan', origin: 'caller', text: '\ud800' }],
      }, signal()),
      /invalidEncoding/,
    );
    await assert.rejects(
      workspace.createDraft({
        ...request,
        documents: [{ kind: 'localDocument', id: 'secret', role: 'plan', source: { root: 'r', path: '.env' } }],
      }, signal()),
    );
    await assert.rejects(
      workspace.createDraft({
        ...request,
        requiredSources: [{ kind: 'codemap', source: { root: 'r', path: 'binary.swift' } }],
      }, signal()),
      /decodeFailed/,
    );
    await workspace.close();
  } finally {
    await runtime.close();
  }
});

test('cancellation and revision changes during preparation prevent late commits; publication claim survives cancellation', async () => {
  const f = await fixture(), entered = barrier(), resume = barrier();
  let pause: NativeOperation['kind'] | null = null;
  class Runtime extends SmipRuntime {
    override makeBridge() {
      class Bridge extends BridgeClient {
        override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
          if (operation.kind === pause) {
            pause = null;
            entered.release();
            await resume.promise;
          }
          return super.request(operation, signal);
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
    const workspace = await runtime.declare(f.spec, signal());
    const draft = await workspace.createDraft(request, signal());
    pause = 'readSource';
    const abort = new AbortController();
    const pending = draft.update({
      expectedRevision: 0,
      maxOutputBytes: 10000,
      mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'a.swift' } } },
    }, abort.signal);
    const refused = assert.rejects(pending);
    await entered.promise;
    abort.abort();
    resume.release();
    await refused;
    assert.equal(draft.revision, 0);
    await draft.prompt(
      { expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  },
      signal(),
    );
    const before = new AbortController();
    before.abort();
    await assert.rejects(draft.finalize(before.signal));
    await assert.rejects(readFile(join(f.base, 'out/packet/manifest.json')));
    await draft.close();
    await workspace.close();
  } finally {
    resume.release();
    await runtime.close();
  }
});

test('range normalization preserves the union and accounting uses exact integer arithmetic', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 50 })), { minLength: 1 }),
      (pairs) => {
        const ranges = pairs.map(([a, b]) => ({ start: Math.min(a, b), end: Math.max(a, b), description: '' }));
        const normalized = normalizeRanges(ranges, 50);
        const lines = (rs: readonly { start: number; end: number }[]) =>
          [...new Set(rs.flatMap((r) => Array.from({ length: r.end - r.start + 1 }, (_, i) => r.start + i)))].sort((
            a,
            b,
          ) => a - b);
        assert.deepEqual(lines(normalized), lines(ranges));
        assert.deepEqual(normalizeRanges(normalized.map((r) => ({ ...r, description: '' })), 50), normalized);
      },
    ),
  );
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      (bytes) => assert.equal(estimateUnits(bytes), Number(21n * BigInt(bytes) / 80n)),
    ),
  );
});

test('minimum mutation receipts commit omitted item costs but reject before commit when even metadata cannot fit', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const workspace = await runtime.declare(f.spec, signal());
    const probe = await workspace.createDraft(request, signal()), draft = await workspace.createDraft(request, signal());
    const mutation = { kind: 'upsert' as const, selection: { kind: 'full' as const, source: { root: 'r', path: 'b.txt' } } };
    const complete = await probe.update({ expectedRevision: 0, maxOutputBytes: 10000, mutation }, signal());
    const minimum = { ...complete, changedCosts: [], incompleteDetails: true };
    const cap = Buffer.byteLength(JSON.stringify(minimum));
    assert(Buffer.byteLength(JSON.stringify(complete)) > cap);
    await assert.rejects(draft.update({ expectedRevision: 0, maxOutputBytes: cap - 1, mutation }, signal()), /outputBudgetTooSmall/);
    assert.equal(draft.revision, 0);
    const result = await draft.update({ expectedRevision: 0, maxOutputBytes: cap, mutation }, signal());
    assert.equal(result.revision, 1);
    assert.equal(result.incompleteDetails, true);
    assert.deepEqual(result.changedCosts, []);
    assert.deepEqual(result.costInspection, { draftId: draft.id, revision: 1 });
    const costs = (await draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal));
    assert(costs.kind === 'costs'); assert.equal(costs.items.length, 1);
    const handoffResult = await draft.prompt({ expectedRevision: 1, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  }, signal());
    assert('revision' in handoffResult); assert.equal(handoffResult.revision, 2);
    await assert.rejects(async () => (await draft.inspect({ view: 'material', materialId: 'missing', continuation: null, maxOutputBytes: 10000 }, new AbortController().signal)), /materialUnavailable/);
    await probe.close(); await draft.close(); await workspace.close();
  } finally { await runtime.close(); }
});

test('prepared mutations cannot cross a freeze or a competing revision even after manual validation reopens editing', async () => {
  for (const scenario of ['freeze', 'revision'] as const) {
    const f = await fixture(), entered = barrier(), resume = barrier();
    let pause = false;
    class Runtime extends SmipRuntime {
      override makeBridge() {
        class Bridge extends BridgeClient {
          override async request<O extends NativeOperation>(operation: O, signal: AbortSignal) {
            if (pause && operation.kind === 'readSource') {
              pause = false;
              entered.release();
              await resume.promise;
            }
            return super.request(operation, signal);
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
      const workspace = await runtime.declare(f.spec, signal()), draft = await workspace.createDraft(
        scenario === 'freeze' ? { ...request, budgetUnits: 1 } : request, signal());
      pause = true;
      const pending = draft.update({
        expectedRevision: 0,
        maxOutputBytes: 10000,
        mutation: { kind: 'upsert', selection: { kind: 'full', source: { root: 'r', path: 'a.swift' } } },
      }, signal());
      const rejected = assert.rejects(pending, scenario === 'freeze' ? /draftFrozen/ : /revisionConflict/);
      await entered.promise;
      if (scenario === 'freeze') assert.equal((await draft.finalize(signal())).kind, 'blocked');
      else {await draft.prompt(
          { expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify(handoff)  },
          signal(),
        );}
      resume.release();
      await rejected;
      assert.equal(draft.selectionProjection().sources.length, 0);
      await draft.close();
      await workspace.close();
    } finally {
      resume.release();
      await runtime.close();
    }
  }
});

test('bounded metadata inspection exposes the current literal prompt and invalidates old pages', async () => {
  const f = await fixture(), runtime = new SmipRuntime(f.options);
  try {
    const client = runtime.createClient(null), other = runtime.createClient(null);
    const workspace = await client.declare(f.spec, signal());
    const draft = await client.createDraft(workspace.id, { ...request, documents: [{ kind: 'suppliedDocument', id: 'doc', role: 'report', origin: 'fixture', text: 'body' }] }, signal());
    const inspect = async (maxOutputBytes: number, continuation: { digest: string; offset: number } | null = null) =>
      (await client.inspect(draft.id, { view: 'metadata', maxOutputBytes, continuation }, new AbortController().signal));
    const unset = (await inspect(10000)); assert(unset.kind === 'metadata');
    assert.deepEqual(unset.items.at(-1), { kind: 'prompt', prompt: request.task }); assert.equal(unset.revision, 0);
    await client.prompt(draft.id, { expectedRevision: 0, maxOutputBytes: 10000, op: 'append', text: '\n\n' + JSON.stringify({ ...handoff, architecture: 'old'.repeat(500) })  }, signal());
    const committed = (await inspect(10000)); assert(committed.kind === 'metadata');
    const cap = Buffer.byteLength(JSON.stringify({ ...committed, items: committed.items.slice(0, 1), truncated: true,
      continuation: { digest: '0'.repeat(64), offset: 1 } }));
    const page = (await inspect(cap)); assert(page.kind === 'metadata' && page.continuation);
    const value = { clarifiedTask: 'complete clarification', architecture: 'architecture'.repeat(200), relationships: ['A uses B', 'C owns D'], ambiguities: ['one', 'two'] };
    await client.prompt(draft.id, { expectedRevision: 1, maxOutputBytes: 10000, op: 'set', text: JSON.stringify(value)  }, signal());
    await assert.rejects(async () => (await inspect(10000, page.continuation)), /staleContinuation/);
    assert.equal((await inspect(cap)).kind, 'metadata');
    const first = (await inspect(cap)); assert(first.kind === 'metadata' && first.continuation);
    const oversized = (await inspect(cap, first.continuation)); assert.equal(oversized.kind, 'recordTooLarge');
    const recovered = (await inspect(10000, first.continuation)); assert(recovered.kind === 'metadata');
    assert.equal(recovered.revision, 2); assert.deepEqual(recovered.items, [{ kind: 'prompt', prompt: JSON.stringify(value) }]);
    await assert.rejects(async () => (await other.inspect(draft.id, { view: 'metadata', maxOutputBytes: 10000, continuation: null }, new AbortController().signal)), /unknownDraft/);
    await writeFile(join(f.base, 'handoff-inspection-proof.json'), JSON.stringify({ unset, oversized, recovered }) + '\n');
    await client.close(); await other.close();
  } finally { await runtime.close(); }
});
