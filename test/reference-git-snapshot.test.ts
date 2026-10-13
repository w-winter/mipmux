import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Unknown(),
  expected: Type.Array(Type.Object({ path: Type.String(), bytes: Type.String() })) })));
const reply = Compile(Type.Object({ result: Type.Object({ kind: Type.Literal('gitSnapshotBytes'),
  files: Type.Array(Type.Object({ path: Type.String(), bytes: Type.String() })) }) }));
const manifest = Compile(Type.Object({ generatedAt: Type.String(), files: Type.Array(Type.Object({ patchPath: Type.Optional(Type.String()) })) }));
const timestamp = 'SOURCE_SNAPSHOT_TIME';

function normalized(path: string, bytes: string) {
  const text = Buffer.from(bytes, 'base64').toString('utf8');
  if (path === 'manifest.json') {
    const value: unknown = JSON.parse(text);
    const parsed = manifest.Parse(value);
    return { ...parsed, generatedAt: timestamp, files: parsed.files.map(file => file.patchPath === undefined
      ? file : { ...file, patchPath: file.patchPath.normalize('NFC') }) };
  }
  if (path === 'MAP.txt') return text.replace(/^SNAPSHOT_GENERATED_AT: .*$/m, 'SNAPSHOT_GENERATED_AT: ' + timestamp)
    .replace(/-> ((?:diff\/per-file\/|_git_data\/)[^\n]*)/g, (_match, target: string) => '-> ' + target.normalize('NFC'));
  if (path === 'index/files.tsv') return text.split('\n').map(line => {
    const columns = line.split('\t'); columns[4] = columns[4]!.normalize('NFC'); return columns.join('\t');
  }).join('\n');
  if (path === 'deep/hunks.jsonl') return text ? text.split('\n').map(line => JSON.parse(line)) : [];
  return text;
}

test('native snapshot serialization matches complete original manifests, MAPs, indexes and patch bytes', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const generation = 'snapshot-reference';
    const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, generation, requestId: entry.name,
        operation: { kind: 'serializeGitSnapshot', input: entry.input } }) + '\n', encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const result = reply.Parse(JSON.parse(child.stdout.trim())).result;
    const written = new Map(result.files.map(file => [file.path.normalize('NFC'), file.bytes]));
    assert.deepEqual([...written.keys()].sort(), entry.expected.map(file => file.path.normalize('NFC')).sort(), entry.name);
    for (const file of entry.expected) {
      const bytes = written.get(file.path.normalize('NFC')); assert.notEqual(bytes, undefined, file.path);
      assert.deepEqual(normalized(file.path, bytes!), normalized(file.path, file.bytes), entry.name + ':' + file.path);
    }
    proof.push({ name: entry.name, files: result.files,
      normalizations: ['Snapshot write timestamp', 'JSON object key order', 'Source-backed platform Unicode form for artifact path identifiers only'] });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-snapshot-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
