import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const reference = process.argv[2], revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!reference || execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw Error('Supply the pinned RPCE checkout');
const base = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/';
const sourcePaths = [base + 'WorkspaceCodemapSelectionGraph.swift', base + 'Models/WorkspaceCodemapSelectionGraphIncrementalModels.swift'];
for (const path of sourcePaths) {
  const expected = execFileSync('git', ['-C', reference, 'rev-parse', revision + ':' + path], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', reference, 'hash-object', path], { encoding: 'utf8' }).trim() !== expected) throw Error('Modified reference source');
}
const original = readFileSync(join(reference, sourcePaths[0]), 'utf8'), model = readFileSync(join(reference, sourcePaths[1]), 'utf8');
const sizeModel = model.slice(model.indexOf('struct WorkspaceCodemapGraphSizeAccounting:'), model.indexOf('\nimport RepoPromptCodeMapCore'));
const sizeCode = 'enum RPCEGraphSizeAccounting {\n' +
  original.slice(original.indexOf('    private enum CandidateSizeOutcome {'), original.indexOf('\n    private static func makeCandidate(')).replace('private enum', 'enum') +
  original.slice(original.indexOf('    private static func fullSize('), original.indexOf('    private static func snapshotNode('))
    .replace('private static func fullSize', 'static func fullSize').replaceAll('PersistentHashMap', 'Dictionary').replaceAll('PersistentHashSet', 'Set') +
  original.slice(original.indexOf('    private static func checkedAdd('), original.indexOf('    private static func fileIDPrecedes(')) + '}';
const bindingPaths = ['StructureSnapshot.swift', 'StructureAdjacency.swift', 'RPCEGraphPolicy.swift', 'RPCEGraphSizePolicy.swift', 'RPCEGraphOrdering.swift'];
const bindings = bindingPaths.map(name => readFileSync('native/Sources/MipmuxBridge/' + name, 'utf8'));
bindings[0] = bindings[0].slice(0, bindings[0].indexOf('struct WorkspaceCodemapGraphPinnedSnapshot'));
const driverPath = 'test/fixtures/graph-size-oracle.swift', driver = readFileSync(driverPath, 'utf8');
const text = [...bindings, sizeModel, sizeCode, driver].join('\n');
const existing = JSON.parse(readFileSync('test/fixtures/rpce-structure/cases.json'));
const seen = new Set(), inputs = [], specifications = [];
for (const entry of existing) for (const root of entry.input.roots) {
  const key = JSON.stringify(root.files); if (seen.has(key)) continue; seen.add(key);
  const name = entry.name + '/' + root.name;
  inputs.push({ name, files: root.files });
  specifications.push({ name, input: { kind: 'reference', case: entry.name, root: root.name } });
}
const file = (path, state, definitions = [], references = []) => ({ path, state, definitions, references });
const additional = [{ name: 'slot-states-and-unsupported', files: [file('unsupported.txt', null), file('pending.swift', 'pending'),
  file('excluded.swift', 'terminalExcluded'), file('failed.swift', 'terminalArtifact'), file('empty.swift', 'empty')] }];
additional.push({ name: 'normalized-postings-matched-symbols-and-both-directions', files: [
  file('é.swift', 'contributed', ['T', 'T', 'Å', 'A\u030a'], ['T', 'Å', 'Missing', 'Missing']),
  file('Peer.swift', 'contributed', ['T', 'Å'], ['Å', 'OtherMissing']),
] });
inputs.push(...additional);
specifications.push(...additional.map(entry => ({ name: entry.name, input: { kind: 'inline', files: entry.files } })));
const work = mkdtempSync(join(tmpdir(), 'mipmux-size-reference-'));
try {
  writeFileSync(join(work, 'main.swift'), text);
  execFileSync('swiftc', [join(work, 'main.swift'), '-o', join(work, 'oracle')], { stdio: 'inherit' });
  const outputs = JSON.parse(execFileSync(join(work, 'oracle'), { input: JSON.stringify(inputs) }));
  const expected = new Map(outputs.map(output => [output.name, output.expected]));
  const directory = 'test/fixtures/rpce-graph-size'; mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cases.json'), JSON.stringify(specifications.map(input => ({ ...input, expected: expected.get(input.name) })), null, 2) + '\n');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ revision, cases: inputs.length,
    sources: sourcePaths.map(path => ({ path, sha256: hash(readFileSync(join(reference, path))) })),
    bindings: [...bindingPaths.map(name => 'native/Sources/MipmuxBridge/' + name), driverPath].map(path => ({ path, sha256: hash(readFileSync(path)) })),
    generator: 'scripts/generate-graph-size-fixtures.mjs', generatorSHA256: hash(text),
    input: 'test/fixtures/rpce-structure/cases.json', inputSHA256: hash(readFileSync('test/fixtures/rpce-structure/cases.json')),
    scope: 'Original fullSize and checked arithmetic run on captured immutable declarations and the retained adjacency adapter; prices/counts are independent of the TypeScript accountant, not proof of app currentness.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: inputs.length }));
} finally { execFileSync('trash', [work]); }
