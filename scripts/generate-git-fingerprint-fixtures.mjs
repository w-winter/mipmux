import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const repository = resolve(process.argv[2]);
const source = 'Sources/RepoPrompt/Infrastructure/VCS/GitService.swift';
const original = execFileSync('git', ['-C', repository, 'show', `${revision}:${source}`]);
const body = original.toString().split('\n').slice(2694, 2778).join('\n');
const model = execFileSync('git', ['-C', repository, 'show', `${revision}:Sources/RepoPromptVCS/GitDiff/Models/GitDiffFingerprint.swift`]);
const files = [{ path: 'modified.txt', text: 'changed\n' }, { path: 'old.txt', text: 'original\n' },
  { path: 'renamed.txt', text: 'destination\n' }, { path: 'é.txt', text: 'unicode\n' }];
const mtime = 1700000000;
const inputs = [
  { name: 'empty', compare: 'uncommitted', base: 'HEAD', status: '' },
  { name: 'modified', compare: 'staged', base: 'HEAD', status: ' M modified.txt\0?? é.txt\0' },
  { name: 'rename-copy', compare: 'uncommitted:topic', base: 'topic', status: 'R  renamed.txt\0old.txt\0C  renamed.txt\0old.txt\0' },
  { name: 'missing-and-duplicates', compare: 'uncommitted-mergebase:topic', base: 'topic', status: ' D absent.txt\0 M modified.txt\0 M modified.txt\0' },
];
const adapter = `import Foundation
import CryptoKit
enum MCPToolWorkCountDiagnostics { static func measureGitParse<T>(_ body: () -> T) -> T { body() } }
func sha256Hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
struct Input: Decodable { let name: String; let base: String; let status: String }
struct Reference {
 let input: Input
 func getHeadSHA(at: URL) async throws -> String { String(repeating: "a", count: 40) }
 func getRefSHA(at: URL, ref: String) async throws -> String { String(repeating: "b", count: 40) }
 func getStatusPorcelainZ(at: URL) async throws -> Data { Data(input.status.utf8) }
${body}
}
${model}
@main struct Main { static func main() async throws {
 let inputs = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
 var outputs: [[String: Any]] = []
 for input in inputs {
  let value = try await Reference(input: input).getStatusFingerprint(at: URL(fileURLWithPath: CommandLine.arguments[1]), baseRef: input.base)
  outputs.append(["name": input.name, "headSHA": value.headSHA, "baseRef": value.baseRef, "statusHash": value.statusHash])
 }
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
} }
`;
const scratch = mkdtempSync(join(tmpdir(), 'smip-git-fingerprint-reference-'));
try {
  for (const file of files) { writeFileSync(join(scratch, file.path), file.text); utimesSync(join(scratch, file.path), mtime, mtime); }
  writeFileSync(join(scratch, 'original.swift'), adapter);
  execFileSync('swiftc', ['-parse-as-library', join(scratch, 'original.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const outputs = JSON.parse(execFileSync(join(scratch, 'reference'), [scratch], { input: JSON.stringify(inputs) }));
  const cases = inputs.map(input => {
    const output = outputs.find(output => output.name === input.name); assert(output);
    const { name, ...expected } = output;
    return { name, compare: input.compare, headSHA: 'a'.repeat(40), baseRefSHA: input.base === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40),
      status: Buffer.from(input.status).toString('base64'), expected };
  });
  const destination = 'test/fixtures/rpce-git-fingerprint'; mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'cases.json'), JSON.stringify({ mtime, files, cases }, null, 2) + '\n');
  writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ sourceRevision: revision, source,
    sourceSHA256: createHash('sha256').update(original).digest('hex'), ranges: [[2695, 2778]],
    referenceSHA256: createHash('sha256').update(adapter).digest('hex'),
    adaptations: ['Supply captured head, base and porcelain bytes through value-only command adapters.',
      'Run the unchanged original fingerprint and path parsing bodies against real files with fixed modification times.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: cases.length }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
