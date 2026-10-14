import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-publication-selection-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-publication-selection/';
mkdirSync(directory, { recursive: true });
const sources = [...JSON.parse(readFileSync('test/fixtures/rpce-selection-transitions/provenance.json')).sources,
  { path: 'Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+TabContext.swift' }];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const entry of sources) {
  const bytes = readFileSync(resolve(checkout, entry.path)), pinned = execFileSync('git', ['-C', checkout, 'show', revision + ':' + entry.path]);
  if (!bytes.equals(pinned)) throw new Error('Modified reference source: ' + entry.path);
  entry.sha256 = hash(bytes);
}
const source = (index, start, end) => {
  const text = readFileSync(resolve(checkout, sources[index].path), 'utf8');
  return start === undefined ? text : text.split('\n').slice(start - 1, end).join('\n');
};
const state = (selectedPaths = [], manualCodemapPaths = [], slices = {}, codemapAutoEnabled = true) =>
  ({ selectedPaths, manualCodemapPaths, slices, codemapAutoEnabled });
const range = (start, end, description) => [{ start, end, description }];
const cases = [
  ['empty', state(), state()],
  ['ordered-union', state(['/root/c', '/root/a']), state(['/root/a', '/root/b'])],
  ['manual-union', state([], ['/root/c', '/root/a']), state([], ['/root/a', '/root/b'])],
  ['captured-slices-win', state(['/root/a'], [], { '/root/a': range(2, 3, 'captured') }),
    state(['/root/a'], [], { '/root/a': range(7, 8, 'latest') })],
  ['latest-new-slices', state(['/root/a']), state(['/root/b'], [], { '/root/b': range(1, 2, 'latest') })],
  ['captured-removal-restored', state(['/root/a']), state()],
  ['deduplicated-paths', state(['/root/a', '/root/a']), state(['/root/b', '/root/a', '/root/b'])],
  ['captured-full-latest-slice', state(['/root/a']), state(['/root/a'], [], { '/root/a': range(4, 5, null) })],
  ['captured-slice-latest-full', state(['/root/a'], [], { '/root/a': range(2, 2, 'retained') }), state(['/root/a'])],
  ['captured-full-latest-manual', state(['/root/both.swift']), state([], ['/root/both.swift'], {}, false), ['/root/both.swift']],
  ['captured-manual-latest-full', state([], ['/root/both.swift'], {}, false), state(['/root/both.swift']), ['/root/both.swift']],
  ...[false, true].flatMap(captured => [false, true].map(latest => ['automatic-' + captured + '-' + latest,
    state([], [], {}, captured), state([], [], {}, latest)])),
].map(([name, captured, latest, removePaths]) => ({ name, input: { kind: 'transitionSelection', selection: latest,
  mutation: { kind: 'gitPublication', contextSelection: captured } }, removePaths: removePaths ?? null }));
const text = ['import Foundation', source(1), source(2).replaceAll('package ', ''),
  source(3).split('package enum GitDiffPathNormalization')[0].replaceAll('package ', '').replace('@_exported import RepoPromptWorkspaceCore', ''),
  source(4).replaceAll('package ', ''), source(0, 5, 26) + '\n}', source(0, 96, 105),
  'struct WorkspaceSelectionMutationService {\n' + source(0, 385, 460) + '\n}', source(5, 1521, 1571),
  `func selection(_ raw: [String: Any]) throws -> StoredSelection {
    let slices = try JSONDecoder().decode([String: [LineRange]].self, from: JSONSerialization.data(withJSONObject: raw["slices"]!))
    return StoredSelection(selectedPaths: raw["selectedPaths"] as! [String], manualCodemapPaths: raw["manualCodemapPaths"] as! [String],
        slices: slices, codemapAutoEnabled: raw["codemapAutoEnabled"] as! Bool)
}
func wire(_ state: StoredSelection) throws -> [String: Any] {
    var slices = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state.slices)) as! [String: [[String: Any]]]
    for key in slices.keys { slices[key] = slices[key]!.map { var range = $0; if range["description"] == nil { range["description"] = NSNull() }; return range } }
    return ["selectedPaths": state.selectedPaths, "manualCodemapPaths": state.manualCodemapPaths,
        "slices": slices, "codemapAutoEnabled": state.codemapAutoEnabled]
}
let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let output = try raw.map { entry -> [String: Any] in
    let input = entry["input"] as! [String: Any], mutation = input["mutation"] as! [String: Any]
    let merged = selectionForPrimaryGitArtifactCommit(latestSelection: try selection(input["selection"] as! [String: Any]),
        contextSelection: try selection(mutation["contextSelection"] as! [String: Any]))
    var result: [String: Any] = ["name": entry["name"]!, "input": input, "expected": try wire(merged), "afterRemoval": NSNull()]
    if let paths = entry["removePaths"] as? [String] {
        let removed = WorkspaceSelectionMutationService().mutatePreResolvedFullFilePaths(base: merged, absolutePaths: paths, mode: .remove)
        result["afterRemoval"] = ["paths": paths, "expected": try wire(removed)]
    }
    return result
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))`,
].join('\n\n') + '\n';
const scratch = mkdtempSync(join(tmpdir(), 'smip-git-selection-reference-'));
try {
  writeFileSync(scratch + '/reference.swift', text);
  execFileSync('swiftc', [scratch + '/reference.swift', '-o', scratch + '/reference'], { stdio: 'inherit' });
  const output = execFileSync(scratch + '/reference', [], { input: JSON.stringify(cases) });
  writeFileSync(directory + 'cases.json', output.toString() + '\n');
  writeFileSync(directory + 'provenance.json', JSON.stringify({ sourceRevision: revision, sources,
    generator: 'scripts/generate-git-publication-selection-fixtures.mjs', generatorSHA256: hash(text), cases: cases.length,
    bindings: ['Unchanged source merge and full-file transition bodies execute over canonical captured absolute paths.',
      'Absent range descriptions are explicit null in the fixture wire format.'],
    limits: ['Pure selection merge only; live draft commits, Git acquisition, advertisement revision checks and finalization are separate integration responsibilities.'],
  }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: cases.length, output: directory }));
} finally { execFileSync('trash', [scratch]); }
