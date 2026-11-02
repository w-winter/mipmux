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
const owner = 'Sources/RepoPrompt/Features/Search/SearchMatch.swift';
const filters = original(owner, [[1214,1233], [1236,1252]]);
const flags = original(owner, [[10,12]]);
const header = original('Sources/RepoPromptC/include/wildmatch.h');
const wrapperHeader = original('Sources/RepoPromptC/include/repo_gitignore.h');
const c = original('Sources/RepoPromptC/src/wildmatch/wildmatch.c');
const wrapper = original('Sources/RepoPromptC/src/wildmatch/repo_wildmatch_wrapper.c');
const names = ['plain.swift', 'caps.SWIFT', 'README', 'sub/Ignore.swift', 'nested/deep/skip.swift', '[ab].swift',
  'a.swift', 'drop/inner.swift', 'Äther.swift'];
const selections = [
  { extensions: [], exclude: [] }, { extensions: ['.swift'], exclude: [] }, { extensions: ['.SWIFT'], exclude: [] },
  { extensions: ['.'], exclude: [] }, { extensions: ['.swift', '.SWIFT'], exclude: [] },
  { extensions: [], exclude: ['IGNORE'] }, { extensions: [], exclude: ['drop*'] },
  { extensions: [], exclude: ['*.SWIFT'] }, { extensions: [], exclude: ['[ab].swift'] },
  { extensions: [], exclude: [''] }, { extensions: [], exclude: ['**/deep/**'] },
  { extensions: [], exclude: ['äTHER'] }, { extensions: ['.swift'], exclude: ['IGNORE', 'a.swift'] },
];
const inputs = selections.map((filters, index) => ({ name: 'filters-' + index, input: { kind: 'matchSearchPaths',
  files: names.map(path => ({ root: 'r', path, rootPath: '/reference' })), filters,
  mode: 'content', pattern: 'needle', isRegex: false, caseSensitive: true, limit: 50 } }));
const driver = `
struct File: Decodable { let path: String }
struct Options: Decodable { let extensions: [String]; let exclude: [String] }
struct Input: Decodable { let files: [File]; let filters: Options }
struct Case: Decodable { let name: String; let input: Input }
struct SearchOptions { let includeExtensions: [String]; let excludePatterns: [String] }
struct SearchFileDescriptor {
    let relativePath: String; let index: Int
    var fileExtension: String? {
        let ext = ((relativePath as NSString).lastPathComponent as NSString).pathExtension
        return ext.isEmpty ? nil : ext
    }
}
extension FileSearchActor {
    func evaluate(_ paths: [SearchFileDescriptor], options: SearchOptions) -> [SearchFileDescriptor] {
        filterFiles(paths, options: options)
    }
}
let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var outputs: [[String: Any]] = []
for item in cases {
    let files = item.input.files.enumerated().map { SearchFileDescriptor(relativePath: $0.element.path, index: $0.offset) }
    let filtered = FileSearchActor().evaluate(files, options: SearchOptions(
        includeExtensions: item.input.filters.extensions, excludePatterns: item.input.filters.exclude))
    let order = filtered.sorted { $0.relativePath < $1.relativePath }.map(\\.index)
    let selected = Set(order)
    outputs.append(["kind": "searchPaths", "order": order, "matches": [], "excluded": files.indices.filter { !selected.contains($0) }])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
`;
const text = 'import Foundation\nimport RepoPromptC\n' + flags + '\nfinal class FileSearchActor {\n' + filters + '\n}\n' + driver;
const scratch = mkdtempSync(join(tmpdir(), 'rpce-search-filters-'));
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
const cases = inputs.map((item, index) => ({ ...item, expected: outputs[index] }));
const generated = { 'cases.json': cases, 'provenance.json': { revision, sources, cases: cases.length,
  generatorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))), combinedSourceSHA256: hash(text),
  bindings: ['The original filterFiles and matchesPattern bodies execute unchanged with original wildmatch C and flags.',
    'The synchronous namespace receives immutable descriptor fields and the two consumed SearchOptions fields. Extension extraction uses Foundation pathExtension as in the record-backed descriptor.',
    'The driver projects retained descriptor indices into content-path order and a complete omitted-index partition. It does not execute path matching, physical discovery, acquisition, authority, content search or the original response DTO.'] } };
for (const [name, value] of Object.entries(generated)) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(directory, name), 'utf8'), bytes, name);
  else writeFileSync(join(directory, name), bytes);
}
console.log(JSON.stringify({ cases: cases.length, byteIdentical: process.argv.includes('--check') }));
