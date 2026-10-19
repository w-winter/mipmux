import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runReference } from './reference-harness.mjs';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-selection-reply-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
const sources = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path => {
  const bytes = execFileSync('git', ['-C', checkout, 'show', revision + ':' + path]);
  sources.push({ path, sha256: hash(bytes) });
  return bytes.toString().split('\n');
};
const slice = (lines, start, end) => lines.slice(start - 1, end).map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n');
const dto = source('Sources/RepoPrompt/Infrastructure/MCP/ToolResultDTOs.swift');
const core = source('Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+SelectionCore.swift');
const settings = source('Sources/RepoPromptSettingsCore/SettingsCopyValues.swift');
const ranges = source('Sources/RepoPromptFoundation/Slices/LineRange.swift');
const body = [slice(core, 615, 625), slice(core, 957, 1255), slice(core, 1448, 1490)].join('\n\n')
  .replaceAll('MCPServerViewModel.CopyPresetProjectionConfig', 'CopyPresetProjectionConfig')
  .replaceAll('PromptEntriesEvaluation.EntryResult', 'CapturedEntryResult');
const constructor = slice(core, 1350, 1370).replace('return ToolResultDTOs', 'let reply = ToolResultDTOs')
  .replace('codeStructure: nil', 'codeStructure: minimal').replace('collections.codemapAutoEnabled', 'input.codemapAutoEnabled');
const adapter = path => readFileSync('native/Sources/SmipBridge/' + path, 'utf8');
const input = adapter('SelectionReplyInput.swift').split('    func render()')[0].replaceAll('private ', '') + '\n}';
const text = [
  'import Foundation', ranges.join('\n').replaceAll('package ', ''),
  adapter('RPCEStructureDTO.swift').split('    struct CodeStructureReplyDTO')[0] + '\n}',
  'extension ToolResultDTOs {\n' + [slice(dto, 478, 528), slice(dto, 552, 825), slice(dto, 1449, 1535)].join('\n\n') + '\n}',
  settings.slice(15, 24).join('\n').replaceAll('package ', ''),
  'enum RPCESelectionReplyAssembler {\n' + body + '\n}',
  adapter('SelectionReplyBindings.swift'),
  adapter('Wire.swift').slice(adapter('Wire.swift').indexOf('struct BridgeFailure'), adapter('Wire.swift').indexOf('struct SourceIdentity')),
  adapter('SliceRangesInput.swift').split('struct SliceRangesInput')[0], input,
  `@main struct Main {
    static func main() async throws {
      let cases = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
      var output: [[String: Any]] = []
      for item in cases {
        let input = try SelectionReplyInput(item["input"]!)
        let collections = input.collections
        let filesReply = await RPCESelectionReplyAssembler.buildSelectedFilesReply(collections: collections, formatter: .init(), tokens: .init())
        let status = input.status, invalid = input.invalidPaths, blocks = input.blocks
        let minimal = input.unmappedPaths.isEmpty && input.pendingPaths.isEmpty ? nil : ToolResultDTOs.SelectedCodeStructureDTO(
          fileCount: 0, content: "", unmappedPaths: input.unmappedPaths.isEmpty ? nil : input.unmappedPaths,
          pendingPaths: input.pendingPaths.isEmpty ? nil : input.pendingPaths)
        let userPresetState: RPCESelectionReplyAssembler.UserPresetState? = nil
        let tokenStats: ToolResultDTOs.TokenStats? = nil
        let tokenAccounting: ToolResultDTOs.TokenAccountingDTO? = nil
        ${constructor}
        let filtered = RPCESelectionReplyAssembler.applyViewFilter(reply, view: input.view)
        let result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(filtered))
        output.append(["name": item["name"]!, "expected": result])
      }
      FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
  }`,
].join('\n');
const directory = 'test/fixtures/rpce-selection-reply/';
const cases = JSON.parse(readFileSync(directory + 'cases.json'));
const results = JSON.parse(runReference(text, JSON.stringify(cases), ['-parse-as-library']));
writeFileSync(directory + 'cases.json', JSON.stringify(cases.map((entry, index) => ({ ...entry, expected: results[index].expected })), null, 2) + '\n');
writeFileSync(directory + 'provenance.json', JSON.stringify({ revision, sources, cases: cases.length, generatorSHA256: hash(text),
  bindings: ['Original DTO, aggregation, copy-projection and view-filter bodies compile independently. Shared immutable input parsing supplies paths, category/ranges and captured token values. App path metadata and token services are replaced by those captured values; workspace token recount and content packaging are not tested by these cases.'] }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length }));
