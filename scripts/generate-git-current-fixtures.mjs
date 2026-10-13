import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3', repository = resolve(process.argv[2]);
const source = 'Sources/RepoPromptVCS/GitDiff/GitDiffSnapshotStore.swift';
const original = execFileSync('git', ['-C', repository, 'show', `${revision}:${source}`]);
const body = original.toString().split('\n').slice(431, 457).join('\n');
assert(body.includes('private func readCurrentPointer'));
const cases = [
  { name: 'relative-link', kind: 'symlink', target: 'dated/one', exists: true },
  { name: 'absolute-link', kind: 'absoluteSymlink', target: 'dated/one', exists: true },
  { name: 'dangling-link', kind: 'symlink', target: 'absent', exists: false },
  { name: 'text-pointer', kind: 'file', target: '\n dated/one \n', exists: true },
  { name: 'missing-target-text', kind: 'file', target: 'absent', exists: false },
  { name: 'empty-text', kind: 'file', target: '\n  \n', exists: false },
  { name: 'missing', kind: 'missing', target: '', exists: false },
];
const program = `import Foundation
struct Reference {
${body}
 func read(_ root: URL) -> String? { readCurrentPointer(at: root.appendingPathComponent("CURRENT"), relativeTo: root) }
}
struct Input: Decodable { let name: String; let kind: String; let target: String; let exists: Bool }
@main struct Main { static func main() throws {
 let cases = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
 var outputs: [[String: Any]] = []
 for entry in cases {
  let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(entry.name)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  if entry.exists { try FileManager.default.createDirectory(at: root.appendingPathComponent("dated/one"), withIntermediateDirectories: true) }
  let pointer = root.appendingPathComponent("CURRENT")
  if entry.kind == "file" { try Data(entry.target.utf8).write(to: pointer) }
  if entry.kind == "symlink" || entry.kind == "absoluteSymlink" {
   let target = entry.kind == "absoluteSymlink" ? root.appendingPathComponent(entry.target).path : entry.target
   try FileManager.default.createSymbolicLink(atPath: pointer.path, withDestinationPath: target)
  }
  outputs.append(["name": entry.name, "snapshotID": Reference().read(root) as Any? ?? NSNull()])
 }
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
} }
`;
const scratch = mkdtempSync(join(tmpdir(), 'smip-current-reference-'));
try {
  writeFileSync(join(scratch, 'original.swift'), program);
  execFileSync('swiftc', ['-parse-as-library', join(scratch, 'original.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const outputs = JSON.parse(execFileSync(join(scratch, 'reference'), [scratch], { input: JSON.stringify(cases) }));
  const destination = 'test/fixtures/rpce-git-current'; mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'cases.json'), JSON.stringify(cases.map(entry => {
    const result = outputs.find(result => result.name === entry.name); assert(result); return { ...entry, expected: result.snapshotID };
  }), null, 2) + '\n');
  writeFileSync(join(destination, 'provenance.json'), JSON.stringify({ sourceRevision: revision, source, ranges: [[432, 457]],
    sourceSHA256: createHash('sha256').update(original).digest('hex'), referenceSHA256: createHash('sha256').update(program).digest('hex'),
    adaptations: ['Compile the unchanged original CURRENT reader with real pointer files and symlinks under isolated temporary directories.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: cases.length }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
