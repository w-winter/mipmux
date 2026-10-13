import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { identity } from '../src/context/material-store.js';

const casesValidator = Compile(Type.Array(Type.Object({
  name: Type.String(), base64: Type.String(),
  expected: Type.Union([Type.String(), Type.Null()]), linuxExpected: Type.Union([Type.String(), Type.Null()]),
})));
const signal = () => new AbortController().signal;

async function fixture() {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-source-decoding-'));
  const root = join(directory, 'source'), outputRoot = join(directory, 'out');
  await mkdir(root); await mkdir(outputRoot);
  const runtime = new SmipRuntime({
    cachePath: join(directory, 'cache'), terminationGraceMs: 100, contextBudgetUnits: 200000,
    credentialPaths: [], nativeEnvironment: {},
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
  });
  const spec = { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot };
  return { directory, root, runtime, spec };
}

test('workspace reads use the original automatic decoder and the approved Linux failure mapping', async () => {
  const cases = casesValidator.Parse(JSON.parse(await readFile('test/fixtures/rpce-decoding/cases.json', 'utf8')));
  const f = await fixture();
  try {
    for (const entry of cases) await writeFile(join(f.root, entry.name + '.txt'), Buffer.from(entry.base64, 'base64'));
    const workspace = await f.runtime.declare(f.spec, signal());
    const operation = await workspace.openOperation(signal()), proof: unknown[] = [];
    try {
      for (const entry of cases) {
        const source = { root: 'r', path: entry.name + '.txt' };
        const expected = process.platform === 'linux' ? entry.linuxExpected : entry.expected;
        if (expected === null) {
          await assert.rejects(operation.readSource(source), /decodeFailed/, entry.name);
          proof.push({ name: entry.name, result: 'decodeFailed' });
        } else {
          const acquired = await operation.readSource(source);
          assert.equal(acquired.text, expected, entry.name);
          assert.deepEqual(acquired.identity, identity(Buffer.from(entry.base64, 'base64')), entry.name);
          proof.push({ name: entry.name, raw: acquired.identity, decoded: identity(acquired.text) });
        }
      }
    } finally { await operation.close(); await workspace.close(); }
    await writeFile(join(f.directory, 'decoder-receipt.json'), JSON.stringify(proof, null, 2) + '\n');
  } finally { await f.runtime.close(); }
});

test('decoded source drives reads, full exports, slices, codemaps and saved/current verification', async () => {
  const f = await fixture();
  const text = 'struct Café {\r\n    let résumé: String\r\n}\r\n';
  const bytes = Buffer.from(text, 'latin1');
  try {
    await writeFile(join(f.root, 'Model.swift'), bytes);
    const workspace = await f.runtime.declare(f.spec, signal());
    const operation = await workspace.openOperation(signal());
    try {
      const read = await operation.readFile({ root: 'r', path: 'Model.swift', start_line: null, offset: null,
        limit: null, maxOutputBytes: 24000, continuation: null });
      assert.equal(read.kind, 'read');
      if (read.kind === 'read') assert.equal(read.content, text);
    } finally { await operation.close(); }
    const request = { task: 'Retain decoded evidence', copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve' as const,
      purpose: 'investigation' as const, requiredSources: [], documents: [], patches: [], discoveryHints: [],
      budgetUnits: 200000, outputName: 'decoded-full' };
    const full = await workspace.createDraft({ ...request, requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Model.swift' } }] }, signal());
    try {
      const ready = await full.finalize(signal()); assert.equal(ready.kind, 'ready');
      if (ready.kind !== 'ready') throw new Error('Expected a ready full packet');
      const context = await readFile(join(ready.directory, 'context.md'));
      const record = ready.manifest.materials.find(record => record.kind === 'source'); assert(record?.kind === 'source');
      const span = record.spans[0]!;
      assert.equal(context.subarray(span.offset, span.offset + span.length).toString(), text);
      assert.deepEqual(record.identity, identity(bytes));
      await verifyBundle(ready.directory); await verifyCurrentBundle(ready.directory, f.runtime, signal());
      const slices = await workspace.createDraft({ ...request, outputName: 'decoded-slices', requiredSources: [
        { kind: 'slices', source: { root: 'r', path: 'Model.swift' }, ranges: [{ start: 2, end: 2, description: 'field' }] },
      ], documents: [{ kind: 'localDocument', id: 'decoded', role: 'evidence', source: { root: 'r', path: 'Model.swift' } }] }, signal());
      try {
        const sliced = await slices.finalize(signal()); assert(sliced.kind === 'ready');
        const loaded = await readFile(join(sliced.directory, 'context.md'));
        const selected = sliced.manifest.materials.find(record => record.kind === 'source'); assert(selected?.kind === 'source');
        const selectedSpan = selected.spans[0]!;
        assert.equal(loaded.subarray(selectedSpan.offset, selectedSpan.offset + selectedSpan.length).toString(), '    let résumé: String\r\n');
        await verifyBundle(sliced.directory); await verifyCurrentBundle(sliced.directory, f.runtime, signal());
        const codemap = await workspace.createDraft({ ...request, outputName: 'decoded-codemap', requiredSources: [
          { kind: 'codemap', source: { root: 'r', path: 'Model.swift' } },
        ] }, signal());
        try {
          const mapped = await codemap.finalize(signal()); assert(mapped.kind === 'ready');
          assert.match(await readFile(join(mapped.directory, 'context.md'), 'utf8'), /Café/);
          await verifyBundle(mapped.directory); await verifyCurrentBundle(mapped.directory, f.runtime, signal());
          await writeFile(join(f.directory, 'pipeline-receipt.json'), JSON.stringify({
            raw: identity(bytes), decoded: identity(text), full: ready.manifest.files, slices: sliced.manifest.files, codemap: mapped.manifest.files,
          }, null, 2) + '\n');
        } finally { await codemap.close(); }
      } finally { await slices.close(); }
      await writeFile(join(f.root, 'Model.swift'), text);
      await assert.rejects(verifyCurrentBundle(ready.directory, f.runtime, signal()), /sourceChanged/);
    } finally { await full.close(); await workspace.close(); }
  } finally { await f.runtime.close(); }
});

test('malformed mandatory Git ignore text cannot silently change source visibility', async () => {
  const f = await fixture();
  try {
    const git = process.env.SMIP_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
    execFileSync(git, ['init', '-q'], { cwd: f.root, env: { PATH: '/usr/bin:/bin', HOME: f.directory,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    await writeFile(join(f.root, '.gitignore'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('*.swift\n', 'utf16le')]));
    await writeFile(join(f.root, 'Model.swift'), 'struct Model {}\n');
    const workspace = await f.runtime.declare(f.spec, signal());
    try {
      const snapshot = await workspace.refresh(signal());
      assert.equal(snapshot.enumeration.kind, 'incomplete');
      if (snapshot.enumeration.kind === 'incomplete') assert(snapshot.enumeration.failures.some(failure => failure.code === 'decodeFailed'));
      await assert.rejects(workspace.createDraft({ task: 'Inspect mandatory visibility', copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'preserve',
        purpose: 'investigation', requiredSources: [], documents: [], patches: [], discoveryHints: [], budgetUnits: 200000,
        outputName: 'invalid-controls' }, signal()), /enumerationIncomplete/);
      await writeFile(join(f.directory, 'control-decode-receipt.json'), JSON.stringify(snapshot.enumeration, null, 2) + '\n');
    } finally { await workspace.close(); }
  } finally { await f.runtime.close(); }
});
