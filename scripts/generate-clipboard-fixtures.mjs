import { withReferenceDirectory } from './reference-harness.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-clipboard-fixtures.mjs <pinned-rpce-checkout>');
const fixtureDirectory = fileURLToPath(new URL('../test/fixtures/rpce-clipboard/', import.meta.url));
withReferenceDirectory('smip-clipboard-reference-', directory => {
writeFileSync(join(directory, 'adapters.swift'), readFileSync(join(fixtureDirectory, 'reference-adapters.swift')));
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [];
const source = (path, retainedRanges, adaptations = []) => {
  const bytes = execFileSync('git', ['-C', checkout, 'show', revision + ':' + path]);
  sources.push({ path, sha256: hash(bytes), retainedRanges, adaptations });
  return bytes.toString();
};
const lines = (text, start, end) => text.split('\n').slice(start - 1, end).join('\n');
const packaging = source('Sources/RepoPrompt/Features/Prompt/Services/PromptPackagingService.swift',
  [[6, 46], [109, 153], [167, 443], [449, 470]], ['Original declarations extracted with their container; bodies unchanged.']);
const assembly = source('Sources/RepoPromptDomainRuntime/ProviderContent/PromptAssemblyBuilder.swift', 'complete');
const slices = source('Sources/RepoPrompt/Infrastructure/WorkspaceContext/Slices/SliceAssembly.swift', 'complete',
  ['Removed import RepoPromptFoundation; original LineRange compiled in same module.']);
const ranges = source('Sources/RepoPromptFoundation/Slices/LineRange.swift', 'complete');
const paths = source('Sources/RepoPromptWorkspaceCore/StandardizedPath.swift', 'complete');
const strings = source('Sources/RepoPromptDomainRuntime/StringExtensions.swift', [[113, 135], [345, 386]],
  ['Extracted methods wrapped in extension String; bodies and package access unchanged.']);
const c = source('Sources/RepoPromptC/src/Utils/string_extensions_wrapper.c', [[784, 961]],
  ['Original split/free implementations compiled with standard includes and extracted declarations.']);
const h = source('Sources/RepoPromptC/include/string_extensions_wrapper.h', [[76, 89]],
  ['Added stddef.h and used Swift bridging header instead of RPCE C module.']);
source('Sources/RepoPrompt/Features/Prompt/Models/Copy/BuiltInCopyPresets.swift', [],
  ['Evidence only: Standard 23–39 and Review 93–109 inclusion flags supplied as resolved caller inputs. Preset resolver not executed.']);
const headerStart = h.indexOf('struct repo_split_result {');
const headerEnd = h.indexOf('void repo_free_split_result(struct repo_split_result *result);') + 'void repo_free_split_result(struct repo_split_result *result);'.length;
if (headerStart < 0 || headerEnd < headerStart) throw new Error('Missing reference C declarations');
const header = '#include <stddef.h>\n' + h.slice(headerStart, headerEnd) + '\n';
const cText = '#include "split.h"\n#include <stdlib.h>\n#include <string.h>\n' + lines(c, 784, 961) + '\n';
const swift = [
  'import Foundation', ranges, paths, assembly, slices.replace('import RepoPromptFoundation', ''),
  'extension String {\n' + lines(strings, 113, 135) + '\n' + lines(strings, 345, 386) + '\n}',
  lines(packaging, 6, 46), lines(packaging, 109, 153), lines(packaging, 167, 443), lines(packaging, 449, 470),
].join('\n');
writeFileSync(join(directory, 'original.swift'), swift);
writeFileSync(join(directory, 'split.h'), header);
writeFileSync(join(directory, 'split.c'), cText);
const order = ['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions'];
const entry = (id, name, content, changes = {}) => ({
  file: { id, rootID: 'one', name, relativePath: 'src/' + name, fullPath: '/fixture/one/src/' + name },
  role: 'ordinary', isCodemap: false, loadedContent: content, lineRanges: null, rootFolderPath: '/fixture/one', ...changes,
});
const full = entry('full', 'Example.swift', 'struct Example {}\n');
const sliced = entry('slice', 'Notes.md', 'first\r\nsecond\nthird\rfourth', {
  lineRanges: [{ start: 1, end: 1, description: 'opening' }, { start: 3, end: 4, description: null }],
});
const codemap = entry('map', 'Neighbor.swift', null, { isCodemap: true });
const patch = entry('patch', 'change.patch', 'diff --git a/Example.swift b/Example.swift\n-old\n+new\n', { role: 'authorizedGitDiffArtifact' });
const metas = [{ title: 'Review "<&>', content: 'Review all supplied evidence.\nKeep uncertainty explicit.' },
  { title: 'Second', content: 'Additional operator instructions.\n' }];
const input = {
  includeDatetimeInUserInstructions: false,
  metaInstructions: metas, userInstructions: 'Original user text\nλ 😀\nDo not omit evidence.\n',
  files: [full, codemap, sliced], fileTreeContent: 'one\n├── src\n│   ├── Example.swift *\n│   ├── Neighbor.swift +\n│   └── Notes.md *',
  gitDiff: null, includeSavedPrompts: false, includeFiles: true, includeUserPrompt: true, filePathDisplay: 'relative',
  codemapPresentation: { renderedEntriesByFileID: { map: { text: 'File: src/Neighbor.swift\n```swift\nstruct Neighbor\n```' } } },
  promptSectionsOrder: order, disabledPromptSections: [], duplicateUserInstructionsAtTop: false, tabTitle: null,
};
const fixture = (name, changes = {}) => ({ name, input: { ...input, ...changes } });
const cases = [
  fixture('standard-resolved-inputs'),
  fixture('review-selected-git-and-explicit-metas', { files: [...input.files, patch], includeSavedPrompts: true, gitDiff: 'SUPPLIED DIFF MUST NOT WIN' }),
  fixture('review-supplied-git-no-selected-artifact', { includeSavedPrompts: true, gitDiff: 'supplied patch\n' }),
  fixture('standard-ordinary-clipboard-selected-git', { files: [...input.files, patch] }),
  fixture('custom-reverse-order', { promptSectionsOrder: [...order].reverse(), includeSavedPrompts: true, gitDiff: 'patch' }),
  fixture('disabled-sections', { disabledPromptSections: ['fileMap', 'gitDiff', 'metaPrompts'], includeSavedPrompts: true, gitDiff: 'patch' }),
  fixture('duplicate-user-instructions', { duplicateUserInstructionsAtTop: true }),
  fixture('disabled-user-still-duplicated-at-top', { duplicateUserInstructionsAtTop: true, disabledPromptSections: ['userInstructions'] }),
  fixture('all-empty', { files: [], fileTreeContent: null, metaInstructions: [], userInstructions: '', includeSavedPrompts: true }),
  fixture('empty-tree-and-supplied-git', { files: [], fileTreeContent: '', gitDiff: '', userInstructions: '', metaInstructions: [] }),
  fixture('codemap-only-map-without-tree-or-files-section', { files: [codemap], fileTreeContent: null, includeFiles: false }),
  fixture('missing-codemap-presentation', { files: [codemap], fileTreeContent: null, codemapPresentation: { renderedEntriesByFileID: {} } }),
  fixture('empty-codemap-presentation', { files: [codemap], fileTreeContent: '', codemapPresentation: { renderedEntriesByFileID: { map: { text: '' } } } }),
  fixture('files-and-user-disabled-by-inclusion', { includeFiles: false, includeUserPrompt: false }),
  fixture('empty-meta-array-enabled', { includeSavedPrompts: true, metaInstructions: [] }),
  fixture('empty-meta-body-and-unescaped-meta-title', { includeSavedPrompts: true, metaInstructions: [{ title: '"<&\'😀', content: '' }] }),
  fixture('escaped-tab-title', { tabTitle: '  A & <B> "C" \'D\' 😀\n ' }),
  fixture('generic-tab-title', { tabTitle: ' T123\n' }),
  fixture('empty-tab-title', { tabTitle: ' \n ' }),
  fixture('non-generic-tab-title', { tabTitle: 'T12a' }),
  fixture('empty-order-title-only', { promptSectionsOrder: [], tabTitle: '<Context>' }),
  fixture('duplicate-order', { promptSectionsOrder: ['userInstructions', 'fileMap', 'userInstructions'] }),
  fixture('unreadable-and-whitespace-selected-git-use-supplied', { files: [entry('unreadable', 'lost.patch', null, { role: 'authorizedGitDiffArtifact' }), entry('white', 'blank.patch', ' \n\t', { role: 'authorizedGitDiffArtifact' })], gitDiff: 'supplied patch', fileTreeContent: null }),
  fixture('multiple-selected-git-input-order', { files: [entry('second', 'second.patch', 'second\n', { role: 'authorizedGitDiffArtifact' }), patch], gitDiff: 'must not win', fileTreeContent: null }),
  fixture('selected-git-sliced-body', { files: [entry('slice-patch', 'slice.patch', 'one\ntwo\nthree\nfour\n', { role: 'authorizedGitDiffArtifact', lineRanges: [{ start: 1, end: 1, description: null }, { start: 3, end: 3, description: null }] })], gitDiff: 'must not win', fileTreeContent: null }),
  fixture('full-path-display', { filePathDisplay: 'full' }),
  fixture('multiple-root-relative-paths', { files: [full, entry('other', 'Other.js', 'export {};', { file: { id: 'other', rootID: 'two', name: 'Other.js', relativePath: 'src/Other.js', fullPath: '/fixture/two/src/Other.js' }, rootFolderPath: '/fixture/two' })] }),
  fixture('unreadable-and-empty-ordinary-content', { files: [entry('missing', 'Missing.swift', null), entry('empty', 'Empty.swift', '')] }),
  fixture('embedded-fence-and-unicode-bytes', { files: [entry('fence', 'README.md', '```\n😀\0λ\n```\n')], userInstructions: 'é\r\n<literal>&\0😀' }),
];
writeFileSync(join(directory, 'inputs.json'), JSON.stringify(cases, null, 2) + '\n');
const commands = [
  ['cc', ['-c', join(directory, 'split.c'), '-o', join(directory, 'split.o')]],
  ['swiftc', ['-parse-as-library', '-package-name', 'RPCEClipboardReference', '-import-objc-header', join(directory, 'split.h'), join(directory, 'original.swift'), join(directory, 'adapters.swift'), join(directory, 'split.o'), '-o', join(directory, 'reference')]],
];
for (const [command, args] of commands) execFileSync(command, args, { stdio: 'inherit' });
const run = () => execFileSync(join(directory, 'reference'), [], { input: readFileSync(join(directory, 'inputs.json')) });
const first = run();
const second = run();
if (!first.equals(second)) throw new Error('Reference output differs between identical runs');
const results = JSON.parse(first);
mkdirSync(join(directory, 'outputs'), { recursive: true });
for (const result of results) writeFileSync(join(directory, 'outputs', result.name + '.txt'), result.text);
writeFileSync(join(fixtureDirectory, 'cases.json'), JSON.stringify(cases.map((item, index) => ({ ...item,
  expected: { kind: 'clipboard', text: results[index].text, utf8Bytes: Buffer.byteLength(results[index].text), sha256: hash(results[index].text) } })), null, 2) + '\n');
writeFileSync(join(fixtureDirectory, 'provenance.json'), JSON.stringify({ revision, sources, cases: cases.length,
  generator: 'scripts/generate-clipboard-fixtures.mjs',
  adapters: 'test/fixtures/rpce-clipboard/reference-adapters.swift',
  adaptersSHA256: hash(readFileSync(join(directory, 'adapters.swift'))),
  harnessSHA256: hash(Buffer.concat(['original.swift', 'adapters.swift', 'split.c', 'split.h'].map(path => readFileSync(join(directory, path))))),
  executionSHA256: hash(first),
  limits: ['Datetime is disabled in all reference inputs.', 'Captured DTOs supply presentation and authorization facts; tree, acquisition, Git queries, preassembly and preset resolution are not executed.'] }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, scratch: directory }));
});
