import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!process.env.RPCE_REFERENCE_ROOT) throw new Error(`Set RPCE_REFERENCE_ROOT to a RepoPrompt CE clone that contains commit ${revision}.`);
const reference = resolve(process.env.RPCE_REFERENCE_ROOT);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [];
function original(path, ranges) {
  const bytes = execFileSync('git', ['show', revision + ':' + path], { cwd: reference });
  const lines = bytes.toString().split('\n');
  const lineCount = bytes.toString().endsWith('\n') ? lines.length - 1 : lines.length;
  const selected = ranges ?? [[1, lineCount]];
  const excerpts = selected.map(([start, end]) => ({ start, end, text: lines.slice(start - 1, end).join('\n') + '\n' }));
  sources.push({ path, sha256: hash(bytes), blob: execFileSync('git', ['rev-parse', revision + ':' + path],
    { cwd: reference, encoding: 'utf8' }).trim(), ranges: excerpts.map(({ start, end, text }) => ({ start, end, sha256: hash(text) })) });
  return excerpts.map(excerpt => excerpt.text).join('\n');
}
const owner = 'Sources/RepoPrompt/Features/Search/SearchPathFiltering.swift';
const kernel = original(owner, [[5,22], [34,51], [58,87], [117,221]]);
const header = original('Sources/RepoPromptC/include/wildmatch.h');
const wrapperHeader = original('Sources/RepoPromptC/include/repo_gitignore.h');
const c = original('Sources/RepoPromptC/src/wildmatch/wildmatch.c');
const wrapper = original('Sources/RepoPromptC/src/wildmatch/repo_wildmatch_wrapper.c');
const snapshots = [
  ['/r', 'src/File.swift', 'Alpha/src/File.swift'], ['/r', 'src/nested/other.swift', 'Alpha/src/nested/other.swift'],
  ['/r', 'srcish/File.swift', 'Alpha/srcish/File.swift'], ['/r', 'Readme.md', 'Alpha/Readme.md'],
  ['/s', 'src/File.swift', 'Beta/src/File.swift'], ['/r/src', 'File.swift', 'Nested/File.swift'],
  ['/r', 'SRC/café.swift', 'Alpha/SRC/café.swift'], ['/r', 'src/cafe\u0301.swift', 'Alpha/src/cafe\u0301.swift'],
].map(([root, relative, display]) => ({ standardizedFullPath: root + '/' + relative,
  standardizedRelativePath: relative, standardizedRootPath: root, clientDisplayPath: display }));
const clauses = [
  { kind: 'exactFile', absPath: '/r/src/File.swift', relPath: 'src/File.swift', restrictedRootPath: '/r' },
  { kind: 'exactFile', absPath: '/absent', relPath: 'src/File.swift', restrictedRootPath: null },
  { kind: 'exactFile', absPath: '/absent', relPath: 'src/File.swift', restrictedRootPath: '/s' },
  { kind: 'exactFile', absPath: '/r/src/café.swift', relPath: 'src/café.swift', restrictedRootPath: '/r' },
  { kind: 'exactFolder', absLower: '/r/src', relLower: 'src', restrictedRootPath: '/r' },
  { kind: 'exactFolder', absLower: '/r/src/', relLower: 'src/', restrictedRootPath: null },
  ...['*.swift', '**/*.swift', 'Alpha/src/*', '/r/src/*', 'src/[Ff]*.swift', 'SRC/*.SWIFT', 'Nested/*'].map(pattern =>
    ({ kind: 'glob', pattern, restrictedRootPath: null })),
  { kind: 'glob', pattern: '*.swift', restrictedRootPath: '/r' },
  ...['src', 'alpha/src', '/r/src', '', '/', 'src/file.swift', 'srcish'].map(candidateLower =>
    ({ kind: 'prefix', candidateLower })),
];
const roots = [
  { id: '00000000-0000-0000-0000-000000000001', name: 'Alpha', path: '/r' },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Beta', path: '/s' },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Nested', path: '/r/src' },
];
const files = snapshots.map(snapshot => ({ rootID: roots.find(root => root.path === snapshot.standardizedRootPath).id,
  path: snapshot.standardizedRelativePath }));
const inputs = [];
for (const caseInsensitive of [false, true]) {
  for (const [index, clause] of clauses.entries()) inputs.push({ name: `clause-${index}-${caseInsensitive}`,
    input: { kind: 'filterSearchScope', roots, files, clauses: [clause], caseInsensitive }, referenceSnapshots: snapshots });
  inputs.push({ name: `or-deduplicated-${caseInsensitive}`, input: { kind: 'filterSearchScope', roots, files,
    clauses: [clauses[0], clauses[4], clauses[6], clauses[0]], caseInsensitive }, referenceSnapshots: snapshots });
}
inputs.push({ name: 'no-clauses', input: { kind: 'filterSearchScope', roots, files, clauses: [], caseInsensitive: true }, referenceSnapshots: snapshots });
inputs.push({ name: 'no-snapshots', input: { kind: 'filterSearchScope', roots, files: [], clauses, caseInsensitive: true }, referenceSnapshots: [] });
const driver = `
extension FileSearchPathSnapshot: Decodable {}
extension SearchPathClause: Decodable {
    private enum Keys: String, CodingKey { case kind, absPath, relPath, absLower, relLower, restrictedRootPath, pattern, candidateLower }
    init(from decoder: any Decoder) throws {
        let value = try decoder.container(keyedBy: Keys.self)
        switch try value.decode(String.self, forKey: .kind) {
        case "exactFile": self = try .exactFile(absPath: value.decode(String.self, forKey: .absPath),
            relPath: value.decode(String.self, forKey: .relPath), restrictedRootPath: value.decodeIfPresent(String.self, forKey: .restrictedRootPath))
        case "exactFolder": self = try .exactFolder(absLower: value.decode(String.self, forKey: .absLower),
            relLower: value.decode(String.self, forKey: .relLower), restrictedRootPath: value.decodeIfPresent(String.self, forKey: .restrictedRootPath))
        case "glob": self = try .glob(pattern: value.decode(String.self, forKey: .pattern),
            restrictedRootPath: value.decodeIfPresent(String.self, forKey: .restrictedRootPath))
        case "prefix": self = try .legacyPrefix(candidateLower: value.decode(String.self, forKey: .candidateLower))
        default: fatalError("Unknown fixture clause")
        }
    }
}
struct Input: Decodable { let clauses: [SearchPathClause]; let caseInsensitive: Bool }
struct Case: Decodable { let name: String; let input: Input; let referenceSnapshots: [FileSearchPathSnapshot] }
let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let outputs: [[String: Any]] = cases.map { item in
    let result = filterPathIndicesResult(snapshots: item.referenceSnapshots,
        spec: SearchPathFilterSpec(caseInsensitive: item.input.caseInsensitive, clauses: item.input.clauses))
    return ["kind": "searchScopeFiltered", "indices": result.matchedSnapshotIndices,
            "visited": result.visitedSnapshotCount, "cancelled": result.cancelled]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
`;
const text = 'import Foundation\nimport RepoPromptC\n' + kernel + driver;
const scratch = mkdtempSync(join(tmpdir(), 'rpce-search-scope-'));
let outputs;
try {
  const include = join(scratch, 'include'); mkdirSync(include);
  writeFileSync(join(include, 'wildmatch.h'), header); writeFileSync(join(include, 'repo_gitignore.h'), wrapperHeader);
  writeFileSync(join(include, 'module.modulemap'), 'module RepoPromptC { header "wildmatch.h" header "repo_gitignore.h" export * }\n');
  for (const [name, source] of [['wildmatch', c], ['wrapper', wrapper]]) {
    writeFileSync(join(scratch, name + '.c'), source);
    execFileSync('cc', ['-I', include, '-c', join(scratch, name + '.c'), '-o', join(scratch, name + '.o')]);
  }
  writeFileSync(join(scratch, 'original.swift'), text); writeFileSync(join(scratch, 'inputs.json'), JSON.stringify(inputs));
  execFileSync('swiftc', ['-module-cache-path', join(scratch, 'cache'), '-I', include, join(scratch, 'original.swift'),
    join(scratch, 'wildmatch.o'), join(scratch, 'wrapper.o'), '-o', join(scratch, 'oracle')]);
  outputs = JSON.parse(execFileSync(join(scratch, 'oracle'), [join(scratch, 'inputs.json')], { encoding: 'utf8' }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
const generated = { 'cases.json': inputs.map(({ name, input }, index) => ({ name, input, expected: outputs[index] })),
  'provenance.json': { revision, sources, cases: inputs.length, generatorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))),
    combinedSourceSHA256: hash(text), bindings: [
      'Original clause types, compiled clauses and index filter execute unchanged with the original wildmatch C wrapper.',
      'Synthetic captured path metadata includes root aliases and overlapping roots. The driver decodes source variants and projects returned indices/visit/cancellation fields.',
      'This proves clause filtering only, not raw path parsing, catalog lookup, freshness, filesystem authority, cancellation delivery or public MCP scope integration.'
    ] } };
for (const [name, value] of Object.entries(generated)) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(directory, name), 'utf8'), bytes, name);
  else writeFileSync(join(directory, name), bytes);
}
console.log(JSON.stringify({ cases: inputs.length, byteIdentical: process.argv.includes('--check') }));
