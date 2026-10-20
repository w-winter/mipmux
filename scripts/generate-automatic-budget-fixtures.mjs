import { withReferenceDirectory } from './reference-harness.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { automaticRootCases } from '../dist-test/test/fixtures/automatic-root-cases.js';

const reference = process.argv[2], revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!reference || execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) {
  throw Error('Supply the pinned RPCE checkout after compiling tests with tsc -p tsconfig.test.json');
}
const graphPath = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/WorkspaceCodemapSelectionGraph.swift';
const modelPath = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/Models/WorkspaceCodemapAutomaticSelectionModels.swift';
for (const path of [graphPath, modelPath]) {
  if (!readFileSync(join(reference, path)).equals(execFileSync('git', ['-C', reference, 'show', revision + ':' + path]))) {
    throw Error('Modified reference source: ' + path);
  }
}
const graph = readFileSync(join(reference, graphPath), 'utf8'), models = readFileSync(join(reference, modelPath), 'utf8');
const method = graph.slice(graph.indexOf('    func automaticSelectionLatest('), graph.indexOf('\n    func traverseLatest('));
if (!method.trimEnd().endsWith('}')) throw Error('Source method boundary changed');
const compare = graph.slice(graph.indexOf('    private static func fileIDPrecedes('), graph.indexOf('\n    private static func edgePrecedes('))
  .replaceAll('PersistentHashMap<UUID, WorkspaceCodemapGraphSnapshotNode>', '[UUID: WorkspaceCodemapGraphSnapshotNode]');
const types = models.slice(models.indexOf('struct WorkspaceCodemapAutomaticSelectionGraphSeed:'),
  models.indexOf('enum WorkspaceCodemapAutomaticSelectionStatus:'));
const adapters = readFileSync('test/fixtures/automatic-query-oracle.swift', 'utf8');
const text = adapters + '\n' + types + `\nfinal class OriginalGraph {
    let pinned: Pinned
    let rootEpoch = WorkspaceCodemapRootEpoch(rootID: UUID(), rootLifetimeID: UUID())
    var pendingQueryCount: UInt64 = 0
    init(pinned: Pinned) { self.pinned = pinned }
    func latestSnapshot() -> Latest { .ready(pinned) }
    func publishAccounting() {}
    func recordQuery(_: Pinned) {}
` + method + compare + `
    private static func utf8Precedes(_ lhs: String, _ rhs: String) -> Bool { WorkspaceCodemapGraphOrdering.utf8Precedes(lhs, rhs) }
}
let cases = try JSONDecoder().decode([Case].self, from: FileHandle.standardInput.readDataToEndOfFile())
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: cases.map { $0.run() }, options: [.sortedKeys]))
`;
withReferenceDirectory('mipmux-automatic-budget-reference-', work => {
  writeFileSync(join(work, 'main.swift'), text);
  execFileSync('swiftc', [join(work, 'main.swift'), '-o', join(work, 'oracle')], { stdio: 'inherit' });
  const output = execFileSync(join(work, 'oracle'), { input: JSON.stringify(automaticRootCases) });
  const directory = 'test/fixtures/rpce-automatic-budget'; mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'cases.json'), JSON.stringify(JSON.parse(output), null, 2) + '\n');
  const hash = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ revision, cases: automaticRootCases.length,
    sources: [graphPath, modelPath].map(path => ({ path, sha256: hash(readFileSync(join(reference, path))) })),
    generator: 'scripts/generate-automatic-budget-fixtures.mjs', generatorSHA256: hash(text),
    input: 'test/fixtures/automatic-root-cases.ts', inputSHA256: hash(readFileSync('test/fixtures/automatic-root-cases.ts')),
    adapters: 'test/fixtures/automatic-query-oracle.swift', adaptersSHA256: hash(adapters),
    scope: 'Original automaticSelectionLatest body and ordering execute against settled captured adjacency. Adapters construct syntactic postings/edges; this proves root-query counting and budgets, not app currentness, matching or outer-store aggregation.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: automaticRootCases.length }));
});
