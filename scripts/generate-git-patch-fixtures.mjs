import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-git-patch-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-git-patch/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().replaceAll('package ', '').replace('import RepoPromptFileSystem\n', '').split('\n');
});
const text = `import Foundation
struct GitService {
${sources[0].slice(2844, 3078).join('\n')}
}
${sources[1].join('\n')}
struct Input: Codable { let text: String }
struct Fixture: Codable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let patches = GitService.splitUnifiedDiffByFile(entry.input.text)
    let files = patches.sorted { $0.key < $1.key }.map { path, patch -> [String: Any] in
        let counts = GitDiffPatchParsing.countChanges(in: patch)
        let hunks = GitDiffPatchParsing.parseHunks(from: patch).map { hunk -> [String: Any] in
            ["header": hunk.header, "oldStart": hunk.oldStart, "oldLines": hunk.oldLines,
             "newStart": hunk.newStart, "newLines": hunk.newLines, "content": hunk.content]
        }
        return ["path": path, "patch": patch, "insertions": counts.insertions, "deletions": counts.deletions, "hunks": hunks]
    }
    output.append(["name": entry.name, "result": ["kind": "gitPatch", "files": files,
        "changedLinesTsv": GitDiffPatchParsing.buildChangedLinesTsv(from: patches)]])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
const inputs = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(referenceOutput);
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expected: entry.result })), null, 2) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length }));
