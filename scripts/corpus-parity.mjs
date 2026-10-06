import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { BridgeClient } from '../dist/native/bridge-client.js';
import { ProcessSupervisor } from '../dist/runtime/process-supervisor.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [operation, ...args] = process.argv.slice(2);
if (operation === 'record') {
  assert.equal(args.length, 4, 'record <corpus.json> <source-root> <output.json> <native-executable>');
  const [manifestPath, sourceRoot, outputPath, executable] = args;
  const manifest = await readFile(manifestPath);
  const corpus = JSON.parse(manifest);
  assert(Array.isArray(corpus));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 1000 });
  const bridge = new BridgeClient({ executable, supervisor, env: { REPOPROMPT_PCRE2_JIT: 'disabled' } });
  const signal = new AbortController().signal;
  const records = [];
  try {
    const description = (await bridge.request({ kind: 'describe' }, signal)).result;
    for (const source of corpus) {
      assert.equal(typeof source.path, 'string');
      assert(!source.path.startsWith('/') && source.path.split('/').every(part => part && part !== '.' && part !== '..'));
      const bytes = await readFile(join(sourceRoot, source.path));
      assert.equal(sha256(bytes), source.sha256, `Changed input: ${source.path}`);
      assert.equal(bytes.length, source.byteCount);
      const result = (await bridge.request({ kind: 'extract', extension: source.path.split('.').at(-1),
        bytes: bytes.toString('base64'), expected: { sha256: source.sha256, byteCount: source.byteCount },
      }, signal)).result;
      assert.equal(result.kind, 'extracted');
      records.push({ source, result });
    }
    for (const source of corpus) assert.equal(sha256(await readFile(join(sourceRoot, source.path))), source.sha256, `Input changed during comparison: ${source.path}`);
    await writeFile(outputPath, JSON.stringify({ corpusSHA256: sha256(manifest), description, records }) + '\n', { flag: 'wx' });
  } finally {
    await bridge.close();
    await supervisor.close();
  }
  console.log(JSON.stringify({ outputPath, records: records.length, corpusSHA256: sha256(manifest) }));
} else if (operation === 'compare') {
  assert.equal(args.length, 2, 'compare <first.json> <second.json>');
  const [first, second] = await Promise.all(args.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  assert.equal(first.corpusSHA256, second.corpusSHA256, 'Refusing different corpora.');
  const mismatches = [];
  if (!isDeepStrictEqual(first.description, second.description)) mismatches.push({ scope: 'description' });
  const outcomes = {};
  for (let index = 0; index < Math.max(first.records.length, second.records.length); index++) {
    const expected = first.records[index], observed = second.records[index];
    if (observed) {
      const kind = observed.result.outcome.kind;
      outcomes[kind] = (outcomes[kind] ?? 0) + 1;
    }
    if (isDeepStrictEqual(expected, observed)) continue;
    mismatches.push({ index, expectedSource: expected?.source ?? null, observedSource: observed?.source ?? null,
      expectedOutcome: expected?.result.outcome.kind ?? null, observedOutcome: observed?.result.outcome.kind ?? null,
      fields: ['key', 'outcome', 'projection'].filter(field => !isDeepStrictEqual(expected?.result[field], observed?.result[field])),
    });
  }
  console.log(JSON.stringify({ equal: mismatches.length === 0, records: second.records.length,
    corpusSHA256: first.corpusSHA256, outcomes, mismatches }));
  if (mismatches.length) process.exitCode = 1;
} else {
  throw new Error('Usage: corpus-parity.mjs record|compare ...');
}
