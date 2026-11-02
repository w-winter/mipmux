import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!process.env.RPCE_REFERENCE_ROOT) throw new Error(`Set RPCE_REFERENCE_ROOT to a RepoPrompt CE clone that contains commit ${revision}.`);
const reference = resolve(process.env.RPCE_REFERENCE_ROOT);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceRecords = [];
function original(path, ranges) {
  const bytes = execFileSync('git', ['show', revision + ':' + path], { cwd: reference });
  const lines = bytes.toString().split('\n');
  const excerpts = ranges.map(([start, end]) => ({ start, end, text: lines.slice(start - 1, end).join('\n') + '\n' }));
  sourceRecords.push({ path, sha256: hash(bytes), blob: execFileSync('git', ['rev-parse', revision + ':' + path],
    { cwd: reference, encoding: 'utf8' }).trim(), ranges: excerpts.map(({ start, end, text }) => ({ start, end, sha256: hash(text) })) });
  return excerpts.map(excerpt => excerpt.text);
}
const service = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/TokenAccounting/TokenCalculationService.swift';
const [components, estimator, calculate] = original(service, [[53, 72], [131, 142], [230, 252]]);
const [projection] = original('Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+TokenStats.swift', [[5, 27]]);
const [dto] = original('Sources/RepoPrompt/Infrastructure/MCP/ToolResultDTOs.swift', [[1489, 1535]]);
const empty = { files: { fullTokens: 0, sliceTokens: 0, codemapTokens: 0 }, promptText: '', selectedInstructionsText: '',
  fileTreeText: '', gitDiffText: null, metadataText: null, duplicateUserInstructionsAtTop: false };
const inputs = [
  { name: 'empty-components', input: empty },
  { name: 'mixed-components-and-duplicate-prompt', input: { ...empty, files: { fullTokens: 10, sliceTokens: 3, codemapTokens: 7 },
    promptText: 'p'.repeat(80), selectedInstructionsText: 'm'.repeat(40), fileTreeText: 't'.repeat(16), metadataText: 'x'.repeat(8),
    gitDiffText: 'g'.repeat(24), duplicateUserInstructionsAtTop: true } },
  { name: 'unicode-and-small-components', input: { ...empty, promptText: '\u0000λ🙂', selectedInstructionsText: 'a\n\nb',
    fileTreeText: 'λ\n', gitDiffText: 'diff\n', metadataText: '\n' } },
  { name: 'empty-optional-texts', input: { ...empty, files: { fullTokens: 1, sliceTokens: 0, codemapTokens: 0 },
    gitDiffText: '', metadataText: '', duplicateUserInstructionsAtTop: true } },
  { name: 'slice-and-codemap-totals', input: { ...empty, files: { fullTokens: 0, sliceTokens: 11, codemapTokens: 19 },
    promptText: 'task\n', selectedInstructionsText: 'role one\n\nrole two' } },
];
const driver = `
struct FileTokens: Decodable { let fullTokens: Int; let sliceTokens: Int; let codemapTokens: Int }
struct Input: Decodable {
    let files: FileTokens
    let promptText: String; let selectedInstructionsText: String; let fileTreeText: String
    let gitDiffText: String?; let metadataText: String?; let duplicateUserInstructionsAtTop: Bool
}
struct Case: Decodable { let name: String; let input: Input }
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: data)
let outputs = try cases.map { item -> [String: Any] in
    let input = item.input
    let breakdown = TokenCalculationService.calculateComponentBreakdown(
        promptText: input.promptText, selectedInstructionsText: input.selectedInstructionsText,
        fileTreeText: input.fileTreeText, gitDiffText: input.gitDiffText, metadataText: input.metadataText,
        duplicateUserInstructionsAtTop: input.duplicateUserInstructionsAtTop)
    let content = input.files.fullTokens + input.files.sliceTokens
    let stats = MCPServerViewModel.makeTokenStats(filesTokens: content + input.files.codemapTokens,
        filesContentTokens: content > 0 ? content : nil,
        codemapsTokens: input.files.codemapTokens > 0 ? input.files.codemapTokens : nil, breakdown: breakdown)
    return ["name": item.name, "tokenStats": try JSONSerialization.jsonObject(with: JSONEncoder().encode(stats))]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
`;
const source = 'import Foundation\n' + components + '\nenum TokenCalculationService {\n' + estimator + calculate +
  '\n}\nenum MCPServerViewModel {\n' + projection + '\n}\nenum ToolResultDTOs {\n' + dto + '\n}\n' + driver;
const scratch = mkdtempSync(join(tmpdir(), 'rpce-token-stats-'));
let outputs;
try {
  writeFileSync(join(scratch, 'original.swift'), source); writeFileSync(join(scratch, 'inputs.json'), JSON.stringify(inputs));
  execFileSync('swiftc', ['-module-cache-path', join(scratch, 'cache'), join(scratch, 'original.swift'), '-o', join(scratch, 'oracle')]);
  outputs = JSON.parse(execFileSync(join(scratch, 'oracle'), [join(scratch, 'inputs.json')], { encoding: 'utf8' }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
const cases = inputs.map((item, index) => ({ name: item.name, input: { kind: 'calculateTokenStats', ...item.input },
  expected: { kind: 'tokenStats', tokenStats: outputs[index].tokenStats } }));
const files = { 'cases.json': cases, 'provenance.json': { revision, sources: sourceRecords, cases: cases.length,
  generatorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))), combinedSourceSHA256: hash(source),
  bindings: ['Original component struct, estimator, calculation, makeTokenStats and Codable DTO execute verbatim in minimal namespaces.',
    'The driver supplies already-counted full/slice/codemap totals and applies the workspace caller zero-to-nil projection.',
    'No cache, filesystem acquisition, tree/Git collection, preset lookup, pending status or scout integration executes.'] } };
for (const [name, content] of Object.entries(files)) {
  const bytes = JSON.stringify(content, null, 2) + '\n';
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(directory, name), 'utf8'), bytes, name);
  else writeFileSync(join(directory, name), bytes);
}
console.log(JSON.stringify({ cases: cases.length, byteIdentical: process.argv.includes('--check') }));
