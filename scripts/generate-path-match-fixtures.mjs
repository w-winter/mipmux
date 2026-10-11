import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-path-match-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-path-match/', provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = entry => {
  const bytes = readFileSync(resolve(checkout, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  return bytes.toString().replaceAll('import RepoPromptFoundation\n', '').replaceAll('import RepoPromptWorkspaceCore\n', '')
    .replaceAll('import RepoPromptFileSystem\n', '').replaceAll('package ', '');
};
const text = provenance.sources.map(source).join('\n') + `
struct Root: Codable { let name: String; let path: String; let files: [String]; let directories: [String] }
struct Input: Codable { let kind: String; let query: String; let roots: [Root] }
struct Fixture: Codable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = try cases.map { entry -> [String: Any] in
    var files: [String: FileRecord] = [:], folders: [String: FolderRecord] = [:], roots: [FolderRecord] = []
    for root in entry.input.roots {
        let rootPath = StandardizedPath.absolute(root.path)
        roots.append(FrozenFolderRecord(name: root.name, relativePath: "", fullPath: rootPath, rootPath: rootPath))
        for relative in root.files {
            let path = StandardizedPath.join(standardizedRoot: rootPath, standardizedRelativePath: relative)
            files[path] = FrozenFileRecord(name: (relative as NSString).lastPathComponent,
                relativePath: relative, fullPath: path, rootFolderPath: rootPath)
        }
        for relative in root.directories {
            let path = StandardizedPath.join(standardizedRoot: rootPath, standardizedRelativePath: relative)
            folders[path] = FrozenFolderRecord(name: (relative as NSString).lastPathComponent,
                relativePath: relative, fullPath: path, rootPath: rootPath)
        }
    }
    let data = StaticPathMatchData(filesByFullPath: files, foldersByFullPath: folders, rootFolders: roots, id: 0)
    let snapshot = PathMatchSnapshot(staticData: data, selectedFileFullPaths: [],
        indexes: PathMatchIndexes.build(files: files, folders: folders, caseSensitive: data.caseSensitive))
    let found = PathMatcher.locate(userPath: entry.input.query, options: PathLocateProfile.mcpSelection.options, snapshot: snapshot)
    let expected: Any = found.map { ["rootPath": $0.rootPath, "correctedPath": $0.correctedPath] } ?? NSNull()
    return ["name": entry.name, "input": try JSONSerialization.jsonObject(with: JSONEncoder().encode(entry.input)), "expected": expected]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
const run = mkdtempSync(join(tmpdir(), 'smip-path-reference-'));
writeFileSync(run + '/reference.swift', text);
execFileSync('swiftc', [run + '/reference.swift', '-o', run + '/reference'], { stdio: 'inherit' });
const inputFile = openSync(directory + 'cases.json', 'r'), outputFile = openSync(run + '/output.json', 'w');
try { execFileSync(run + '/reference', [], { stdio: [inputFile, outputFile, 'inherit'] }); }
finally { closeSync(inputFile); closeSync(outputFile); }
const output = readFileSync(run + '/output.json');
writeFileSync(directory + 'cases.json', output.toString() + '\n');
provenance.cases = JSON.parse(output).length; provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: provenance.cases, scratch: run }));
