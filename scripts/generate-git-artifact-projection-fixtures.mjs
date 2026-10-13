import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'test/fixtures/rpce-git-artifact-projection');
const repository = resolve(process.argv[2]);
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [];
function retain(path, ranges) {
  const bytes = execFileSync('git', ['-C', repository, 'show', `${revision}:${path}`]);
  const lines = bytes.toString().split('\n');
  const retained = ranges || [[1, lines.length - (lines.at(-1) === '' ? 1 : 0)]];
  sources.push({ path, sha256: hash(bytes), ranges: retained });
  return retained.map(([start, end]) => lines.slice(start - 1, end).join('\n')).join('\n');
}
const adapt = text => text.replaceAll('package ', '').replace(/^import RepoPrompt\w+\n/gm, '');
const vcs = 'Sources/RepoPromptVCS/GitDiff/';
const mcp = 'Sources/RepoPrompt/Infrastructure/MCP/';
let swift = ['Models/GitDiffPublishMode.swift', 'Models/GitDiffScope.swift', 'Models/GitDiffFingerprint.swift',
  'Models/GitDiffSnapshotManifest.swift', 'GitDiffPrimaryArtifacts.swift', 'GitDiffPublishedArtifacts.swift',
  'GitDiffPatchParsing.swift', 'GitDiffSnapshotStore.swift'].map(path => adapt(retain(vcs + path))).join('\n');
swift += '\n' + adapt(retain('Sources/RepoPromptVCS/GitRepositoryLayout.swift'));
swift += '\n' + adapt(retain('Sources/RepoPromptWorkspaceCore/StandardizedPath.swift'));
swift += '\nenum ToolResultDTOs {\n' + retain(mcp + 'ToolResultDTOs.swift', [[2045, 2511]]) + '\n}\n';
swift += '\n' + adapt(retain(mcp + 'WindowTools/MCPGitToolProjection.swift', [[1, 19], [157, 371], [481, 564]]));
swift += '\n' + readFileSync(join(directory, 'adapters.swift'), 'utf8');
swift += `\n@MainActor func assembleReply(projection: MCPGitToolProjection.ArtifactProjection,
primaryArtifacts: ToolResultDTOs.GitToolReplyDTO.PrimaryArtifactsDTO, snapshotID: String,
snapshotDirRel: String, primaryWorktree: ToolResultDTOs.GitToolReplyDTO.WorktreeDTO?,
combinedWarning: String?) -> ToolResultDTOs.GitToolReplyDTO {
typealias Reply = ToolResultDTOs.GitToolReplyDTO
${retain(mcp + 'WindowTools/MCPGitToolProvider.swift', [[1399, 1417]])}
}\n`;
swift += '\n' + readFileSync(join(directory, 'runner.swift'), 'utf8');
const corpusPath = join(root, 'test/fixtures/rpce-git-snapshot/cases.json');
const scratch = mkdtempSync(join(tmpdir(), 'smip-artifact-projection-reference-'));
try {
  for (const name of ['requests.json', 'empty-reasons.json']) writeFileSync(join(scratch, name), readFileSync(join(directory, name)));
  for (const fixture of JSON.parse(readFileSync(corpusPath))) {
    for (const file of fixture.expected) {
      const path = join(scratch, 'snapshots/_git_data/repos/fixture-repo', fixture.name, file.path);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, Buffer.from(file.bytes, 'base64'));
    }
  }
  writeFileSync(join(scratch, 'original.swift'), swift);
  execFileSync('swiftc', ['-parse-as-library', join(scratch, 'original.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const bytes = execFileSync(join(scratch, 'reference'), [scratch], { maxBuffer: 20 * 1024 * 1024 });
  const output = JSON.parse(bytes), requests = JSON.parse(readFileSync(join(directory, 'requests.json')));
  assert.equal(output.cases.length, requests.length);
  assert.equal(output.emptyReasons.length, 10);
  assert(output.multiRepoReply.aggregate.repo_count === 3);
  const expected = bytes.toString().replaceAll(scratch, '$FIXTURE_DIRECTORY');
  writeFileSync(join(directory, 'expected.json'), expected);
  writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ revision, sources,
    corpusSHA256: hash(readFileSync(corpusPath)), compiledSourceSHA256: hash(swift), expectedSHA256: hash(expected),
    adaptations: ['Remove package access and unavailable module imports for standalone compilation.',
      'Supply value-only diff input and repository declarations for unused writer bodies.',
      'Execute original projection closures on MainActor without app worker or telemetry.',
      'Normalize only the scratch directory prefix in published-artifact diagnostic paths; DTOs and snapshot bytes remain exact.'],
    limits: ['No live acquisition, selection, cancellation, readiness or transport executes in this reference generator.'],
  }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: output.cases.length, emptyReasons: output.emptyReasons.length, expectedSHA256: hash(expected) }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
