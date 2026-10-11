import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-selection-transition-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-selection-transitions/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = (index, start, end) => {
  const entry = provenance.sources[index], bytes = readFileSync(resolve(checkout, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  return start === undefined ? bytes.toString() : bytes.toString().split('\n').slice(start - 1, end).join('\n');
};
const text = [
  'import Foundation', source(1), source(2).replaceAll('package ', ''),
  source(3).split('package enum GitDiffPathNormalization')[0].replaceAll('package ', '').replace('@_exported import RepoPromptWorkspaceCore', ''),
  source(4).replaceAll('package ', ''), source(0, 5, 26) + '\n}', source(0, 96, 105),
  'struct WorkspaceSelectionMutationService {\n' + source(0, 385, 460) + '\n}',
  `let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
let decoder = JSONDecoder()
let output = try raw.map { entry -> [String: Any] in
    let input = entry["input"] as! [String: Any], state = input["selection"] as! [String: Any]
    let slices = try decoder.decode([String: [LineRange]].self, from: JSONSerialization.data(withJSONObject: state["slices"]!))
    let selection = StoredSelection(selectedPaths: state["selectedPaths"] as! [String],
        manualCodemapPaths: state["manualCodemapPaths"] as! [String], slices: slices,
        codemapAutoEnabled: state["codemapAutoEnabled"] as! Bool)
    let mutation = input["mutation"] as! [String: Any], paths = mutation["paths"] as! [String]
    let service = WorkspaceSelectionMutationService()
    let result: StoredSelection
    if mutation["kind"] as! String == "fullFiles" {
        result = service.mutatePreResolvedFullFilePaths(base: selection, absolutePaths: paths,
            mode: mutation["op"] as! String == "add" ? .add : .remove)
    } else {
        let target = mutation["target"] as! String
        result = service.setPreResolvedFilePaths(base: selection, absolutePaths: paths,
            targetState: target == "full" ? .full : target == "codemapOnly" ? .codemapOnly : .unselected)
    }
    let encoder = JSONEncoder()
    var sliceObjects = try JSONSerialization.jsonObject(with: encoder.encode(result.slices)) as! [String: [[String: Any]]]
    for path in sliceObjects.keys {
        sliceObjects[path] = sliceObjects[path]!.map { range in
            var output = range; if output["description"] == nil { output["description"] = NSNull() }; return output
        }
    }
    return ["name": entry["name"]!, "input": input, "expected": [
        "selectedPaths": result.selectedPaths, "manualCodemapPaths": result.manualCodemapPaths,
        "slices": sliceObjects, "codemapAutoEnabled": result.codemapAutoEnabled]]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))`,
].join('\n\n') + '\n';
const run = mkdtempSync(join(tmpdir(), 'smip-selection-reference-'));
writeFileSync(run + '/reference.swift', text);
execFileSync('swiftc', [run + '/reference.swift', '-o', run + '/reference'], { stdio: 'inherit' });
const inputFile = openSync(directory + 'cases.json', 'r'), outputFile = openSync(run + '/output.json', 'w');
try { execFileSync(run + '/reference', [], { stdio: [inputFile, outputFile, 'inherit'] }); }
finally { closeSync(inputFile); closeSync(outputFile); }
const output = readFileSync(run + '/output.json');
writeFileSync(directory + 'cases.json', output.toString() + '\n');
provenance.cases = JSON.parse(output).length;
provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: provenance.cases, scratch: run }));
