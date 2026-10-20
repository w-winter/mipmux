import { withReferenceDirectory } from './reference-harness.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-file-block-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const sources = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const source = path => {
  const bytes = execFileSync('git', ['-C', checkout, 'show', revision + ':' + path]);
  sources.push({ path, sha256: hash(bytes) });
  return bytes.toString();
};
const lines = (text, start, end) => text.split('\n').slice(start - 1, end).join('\n');
const packaging = source('Sources/RepoPrompt/Features/Prompt/Services/PromptPackagingService.swift');
const assembly = source('Sources/RepoPrompt/Infrastructure/WorkspaceContext/Slices/SliceAssembly.swift');
const strings = source('Sources/RepoPromptDomainRuntime/StringExtensions.swift');
const ranges = source('Sources/RepoPromptFoundation/Slices/LineRange.swift');
const c = source('Sources/RepoPromptC/src/Utils/string_extensions_wrapper.c');
const h = source('Sources/RepoPromptC/include/string_extensions_wrapper.h');
const headerStart = h.indexOf('struct repo_split_result {');
const headerEnd = h.indexOf('void repo_free_split_result(struct repo_split_result *result);') + 'void repo_free_split_result(struct repo_split_result *result);'.length;
const header = '#include <stddef.h>\n' + h.slice(headerStart, headerEnd) + '\n';
withReferenceDirectory('mipmux-file-block-reference-', scratch => {
writeFileSync(join(scratch, 'split.h'), header);
writeFileSync(join(scratch, 'split.c'), '#include "split.h"\n#include <stdlib.h>\n#include <string.h>\n' + lines(c, 784, 961) + '\n');
const functions = [lines(packaging, 13, 17), lines(packaging, 403, 443), lines(packaging, 449, 451)]
  .join('\n').replaceAll('private static', 'static');
const text = [
  'import Foundation', ranges.replaceAll('package ', ''),
  'extension String {\n' + lines(strings, 113, 135).replace('package static', 'static') + '\n' + lines(strings, 345, 386) + '\n}',
  assembly.replace('import RepoPromptFoundation', ''),
  'enum RPCEPromptFileBlocks {\n' + functions + '\n}',
  `struct Input: Decodable {
    let kind: String; let selectedPath: String; let fileName: String; let content: String; let ranges: [LineRange]?
  }
  struct Fixture: Decodable { let name: String; let input: Input }
  @main struct Main {
    static func main() throws {
      let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
      let output = cases.map { item -> [String: Any] in
        let input = item.input
        let assembly = SliceAssemblyBuilder.build(from: input.content, ranges: input.ranges)
        let text = RPCEPromptFileBlocks.renderFileBlock(selectedPath: input.selectedPath,
          startFence: RPCEPromptFileBlocks.codeFenceStart(for: input.fileName), content: input.content, assembly: assembly)
        let segments = assembly.segments.map { segment -> [String: Any] in
          ["start": segment.range.start, "end": segment.range.end,
           "description": segment.range.description.map { $0 as Any } ?? NSNull(), "text": segment.text]
        }
        return ["name": item.name, "expected": ["kind": "fileBlock", "text": text, "segments": segments,
          "combinedText": assembly.combinedText, "totalLines": assembly.totalLines,
          "detectedLineEnding": assembly.detectedLineEnding, "isFullFile": assembly.isFullFile]]
      }
      FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
  }`,
].join('\n');
writeFileSync(join(scratch, 'reference.swift'), text);
execFileSync('cc', ['-c', join(scratch, 'split.c'), '-o', join(scratch, 'split.o')], { stdio: 'inherit' });
execFileSync('swiftc', ['-parse-as-library', '-package-name', 'MipmuxReference', '-import-objc-header', join(scratch, 'split.h'), join(scratch, 'reference.swift'),
  join(scratch, 'split.o'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
const range = (start, end, description = null) => ({ start, end, description });
const fixture = (name, content, ranges, fileName = 'Example.swift') => ({ name, input: {
  kind: 'renderFileBlock', selectedPath: 'root/' + fileName, fileName, content, ranges,
} });
const cases = [
  fixture('full-final-newline', 'struct Example {}\n', null),
  fixture('full-no-final-newline', 'text', null, 'README'),
  fixture('full-empty', '', null),
  fixture('full-embedded-fence', '```\ninside\n```\n', null, 'Example.md'),
  fixture('slice-mixed-endings', 'one\r\ntwo\rthree\nfour', [range(2, 3, 'Mixed endings')]),
  fixture('slice-disjoint', 'one\ntwo\nthree\nfour\n', [range(1, 1, 'First'), range(3, 3, 'Third')]),
  fixture('slice-merged-descriptions', 'one\ntwo\nthree\nfour\n', [range(2, 3, 'Second'), range(1, 2, 'First'), range(4, 4, 'Fourth')]),
  fixture('slice-clamped-end', 'one\ntwo\n', [range(2, 20)]),
  fixture('slice-outside-file', 'one\ntwo\n', [range(20, 30)]),
  fixture('slice-empty-ranges', 'one\n', []),
  fixture('slice-empty-file', '', [range(1, 1)]),
  fixture('unicode-and-nul', '\ufeff😀\0text\r\nλ\n', [range(1, 2, 'Unicode')]),
  fixture('canonical-equivalent-descriptions', 'one\ntwo\n', [range(1, 1, 'é'), range(2, 2, 'é')]),
];
const results = JSON.parse(execFileSync(join(scratch, 'reference'), { input: JSON.stringify(cases), encoding: 'utf8' }));
const directory = 'test/fixtures/rpce-file-blocks/';
mkdirSync(directory, { recursive: true });
writeFileSync(directory + 'cases.json', JSON.stringify(cases.map((item, index) => ({ ...item, expected: results[index].expected })), null, 2) + '\n');
writeFileSync(directory + 'provenance.json', JSON.stringify({ revision, sources, cases: cases.length, generatorSHA256: hash(text),
  bindings: ['Original formatting, slice assembly, Swift scalar splitting and C ending detection compile independently. Inputs supply already resolved display paths; path routing and final packet assembly are not covered. The reference-only harness imports its extracted C declarations through a temporary header; shipped targets use an explicit C module.'] }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, scratch }));
});
