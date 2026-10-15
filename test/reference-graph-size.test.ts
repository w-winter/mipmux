import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { evaluateStructureResidency } from '../src/workspace/structure-residency.js';
import { structuralFile } from './fixtures/structural-inventory.js';

const file = Type.Object({ path: Type.String(), state: Type.Union([Type.Enum(['contributed', 'empty', 'pending', 'terminalArtifact', 'terminalExcluded']), Type.Null()]),
  definitions: Type.Array(Type.String()), references: Type.Array(Type.String()) });
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Union([
  Type.Object({ kind: Type.Literal('inline'), files: Type.Array(file) }),
  Type.Object({ kind: Type.Literal('reference'), case: Type.String(), root: Type.String() }),
]),
  expected: Type.Object({ nodes: Type.String(), postings: Type.String(), edges: Type.String(), bytes: Type.String() }) })));
const corpusSchema = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({
  roots: Type.Array(Type.Object({ name: Type.String(), files: Type.Array(file) })),
}) })));

test('native-free resident accounting matches the original fullSize prices and counters', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-graph-size/cases.json', 'utf8')));
  const corpus = corpusSchema.Parse(JSON.parse(await readFile('test/fixtures/rpce-structure/cases.json', 'utf8')));
  const proof: unknown[] = [];
  for (const entry of cases) {
    const input = entry.input;
    const files = input.kind === 'inline' ? input.files : referencedFiles(input.case, input.root, corpus);
    const definitions = new Map<string, ReturnType<typeof structuralFile>[]>();
    for (const file of files) {
      if (file.state !== 'contributed' && file.state !== 'empty') continue;
      const captured = structuralFile('r', file.path, file.definitions, file.references);
      for (const name of new Set(file.definitions.map(name => name.normalize('NFC')))) {
        const matches = definitions.get(name) ?? []; matches.push(captured); definitions.set(name, matches);
      }
    }
    const result = evaluateStructureResidency(files, definitions);
    assert.equal(result.kind, 'admitted', entry.name); assert(result.kind === 'admitted');
    assert.deepEqual(result.size, entry.expected, entry.name);
    proof.push({ name: entry.name, result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-graph-size-proof.json', JSON.stringify(proof, null, 2) + '\n');
});

function referencedFiles(name: string, rootName: string, corpus: ReturnType<typeof corpusSchema.Parse>) {
  const entry = corpus.find(entry => entry.name === name); assert(entry, name);
  const root = entry.input.roots.find(root => root.name === rootName); assert(root, rootName);
  return root.files;
}
