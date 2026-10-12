import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-selection-hint-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
const source = 'Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel.swift';
const bytes = execFileSync('git', ['-C', checkout, 'show', revision + ':' + source]), lines = bytes.toString().split('\n');
const method = lines.slice(5866, 5900).join('\n').replace('private func', 'func');
const pathSource = 'Sources/RepoPromptWorkspaceCore/StandardizedPath.swift';
const pathBytes = execFileSync('git', ['-C', checkout, 'show', revision + ':' + pathSource]);
const directory = 'test/fixtures/rpce-selection-hints/';
const cases = JSON.parse(readFileSync(directory + 'cases.json'));
const text = `import Foundation
${pathBytes.toString().replaceAll('package ', '')}
struct Root: Codable {
  let name: String
  let path: String
  var fullPath: String { path }
  var standardizedFullPath: String { StandardizedPath.absolute(path) }
}
struct WorkspaceLookupContext {
  let rootScope: Int = 0
  let bindingProjection: Projection? = nil
  struct Projection { let visibleLogicalRootRefs: [Root] }
  static let visibleWorkspace = WorkspaceLookupContext()
  func translateInputPath(_ value: String) -> String { value }
}
struct Store {
  let roots: [Root]
  func rootRefs(scope: Int) async -> [Root] { roots }
}
struct Prompt { let workspaceFileContextStore: Store }
struct Reference {
  let promptVM: Prompt
${method}
}
struct Input: Codable { let roots: [Root]; let paths: [String]; let operation: String }
struct Fixture: Codable { let name: String; let input: Input }
@main struct Main {
  static func main() async throws {
    let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
    var output: [[String: String]] = []
    for entry in cases {
      let reference = Reference(promptVM: Prompt(workspaceFileContextStore: Store(roots: entry.input.roots)))
      let message = await reference.makeSelectionHintError(paths: entry.input.paths, operation: entry.input.operation)
      output.append(["name": entry.name, "expected": message])
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
  }
}
`;
const scratch = mkdtempSync(join(tmpdir(), 'smip-selection-hints-reference-'));
writeFileSync(join(scratch, 'reference.swift'), text);
execFileSync('swiftc', ['-parse-as-library', join(scratch, 'reference.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
const results = JSON.parse(execFileSync(join(scratch, 'reference'), { input: JSON.stringify(cases), encoding: 'utf8' }));
writeFileSync(directory + 'cases.json', JSON.stringify(cases.map((entry, index) => ({ ...entry, expected: results[index].expected })), null, 2) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify({ revision,
  sources: [{ path: source, sha256: hash(bytes), ranges: [[5867, 5900]] }, { path: pathSource, sha256: hash(pathBytes) }],
  generatorSHA256: hash(text), cases: cases.length,
  bindings: ['Captured root names/paths replace the app store lookup. Root projection and absolute input translation are identity for these headless fixture roots. Original hint method and StandardizedPath bodies execute independently.'] }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, scratch }));
