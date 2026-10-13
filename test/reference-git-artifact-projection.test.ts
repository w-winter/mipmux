import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { GitArtifactReposReply, type NativeGitArtifactInput } from '../src/contracts/git-artifact.js';
import { nativeFrameValidator, nativeRequestValidator } from '../src/contracts/native.js';

const directory = 'test/fixtures/rpce-git-artifact-projection';
const requests = Compile(Type.Array(Type.Object({ name: Type.String(), snapshot: Type.String(),
  inlineMap: Type.Boolean(), inlineMode: Type.String(), inlineMaxLines: Type.Integer(),
  autoSelectedPaths: Type.Array(Type.String()), mapState: Type.String() })));
const snapshots = Compile(Type.Array(Type.Object({ name: Type.String(), expected: Type.Array(Type.Object({
  path: Type.String(), bytes: Type.String() })) })));
const expected = Compile(Type.Object({ cases: Type.Array(Type.Object({ name: Type.String(), reply: Type.Unknown(),
  publishedArtifacts: Type.Unknown(), primarySelectionAliases: Type.Unknown(), advertisedSelectionAliases: Type.Unknown() })),
  multiRepoReply: GitArtifactReposReply }));

function project(operation: NativeGitArtifactInput) {
  const generation = 'artifact-projection-reference';
  const request = nativeRequestValidator.Parse({ wireVersion: 1, generation, requestId: 'projection', operation });
  const child = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
    input: JSON.stringify(request) + '\n', encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const frame = nativeFrameValidator.Parse(JSON.parse(child.stdout.trim()));
  assert(frame.kind === 'terminal');
  return frame.result;
}

test('artifact projection matches original replies, inline text, alias collisions and multi-repository decoration', async () => {
  const inputs = requests.Parse(JSON.parse(await readFile(directory + '/requests.json', 'utf8')));
  const corpus = snapshots.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')));
  const outputs = expected.Parse(JSON.parse(await readFile(directory + '/expected.json', 'utf8')));
  const proof: unknown[] = [], manifests: Record<string, string> = {};
  for (const input of inputs) {
    const snapshot = corpus.find(entry => entry.name === input.snapshot); assert(snapshot);
    const manifest = snapshot.expected.find(file => file.path === 'manifest.json'); assert(manifest);
    const map = snapshot.expected.find(file => file.path === 'MAP.txt'); assert(map);
    const snapshotDir = 'repos/fixture-repo/' + input.snapshot;
    const metadata = Compile(Type.Object({ compare: Type.String(), mode: Type.Enum(['quick', 'standard', 'deep']) }))
      .Parse(JSON.parse(Buffer.from(manifest.bytes, 'base64').toString('utf8')));
    manifests[snapshotDir] = manifest.bytes;
    const result = project({ kind: 'projectGitArtifacts', snapshotDir, snapshotDirectoryPath: '/reference/_git_data/' + snapshotDir,
      manifest: manifest.bytes, availablePaths: snapshot.expected.map(file => file.path).filter(path => input.mapState !== 'missing' || path !== 'MAP.txt'),
      mapBytes: input.mapState === 'missing' ? null : input.mapState === 'invalid-utf8' ? Buffer.from([255, 254, 255]).toString('base64') : map.bytes,
      compareDisplay: metadata.compare,
      mode: metadata.mode, inlineMap: input.inlineMap, inlineMode: input.inlineMode,
      inlineMaxLines: input.inlineMaxLines, autoSelectedPaths: input.autoSelectedPaths, worktree: null, warning: null });
    const reference = outputs.cases.find(entry => entry.name === input.name); assert(reference);
    assert(result.kind === 'gitArtifacts');
    const normalized = { ...result, publishedArtifacts: result.publishedArtifacts.map(artifact => ({ ...artifact,
      absolutePath: artifact.absolutePath.replace(/^\/reference(?=\/)/u, '$FIXTURE_DIRECTORY/snapshots') })) };
    assert.deepEqual(normalized, { kind: 'gitArtifacts', reply: reference.reply,
      publishedArtifacts: reference.publishedArtifacts, primarySelectionAliases: reference.primarySelectionAliases,
      advertisedSelectionAliases: reference.advertisedSelectionAliases }, input.name);
    proof.push({ name: input.name, result });
  }
  const repos = outputs.multiRepoReply.repos.map(repo => {
    if ('error' in repo) return repo;
    const { primary_artifacts: _primary, ...value } = repo;
    return { ...value, warning: '  acquisition warning  ' };
  });
  const multi = project({ kind: 'decorateGitArtifacts', repos, manifests,
    autoSelectedPaths: ['_git_data/repos/fixture-repo/quick-selected/MAP.txt'],
    readinessWarnings: { 'repos/fixture-repo/quick-selected': '  readiness warning \n' } });
  assert.deepEqual(multi, { kind: 'gitArtifactRepos', reply: outputs.multiRepoReply });
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-artifact-projection-proof.json', JSON.stringify({ cases: proof, multi }, null, 2) + '\n');
});

test('artifact projection rejects mismatched snapshot identities and unsafe manifest paths before advertising them', async () => {
  const corpus = snapshots.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-snapshot/cases.json', 'utf8')));
  const fixture = corpus.find(entry => entry.name === 'standard-selected'); assert(fixture);
  const file = fixture.expected.find(file => file.path === 'manifest.json'); assert(file);
  const value: unknown = JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8'));
  const manifest = Compile(Type.Object({ files: Type.Array(Type.Object({ patchPath: Type.Optional(Type.String()) })) })).Parse(value);
  const operation: Extract<NativeGitArtifactInput, { kind: 'projectGitArtifacts' }> = { kind: 'projectGitArtifacts', snapshotDir: 'repos/fixture-repo/standard-selected',
    snapshotDirectoryPath: '/reference/_git_data/repos/fixture-repo/standard-selected', manifest: file.bytes,
    availablePaths: fixture.expected.map(file => file.path), mapBytes: null, compareDisplay: 'uncommitted',
    mode: 'standard', inlineMap: true, inlineMode: 'brief', inlineMaxLines: 120, autoSelectedPaths: [], worktree: null, warning: null };
  for (const changed of [{ ...manifest, repoKey: 'other' }, { ...manifest, snapshotID: 'other' },
    { ...manifest, files: [{ patchPath: 'diff/../../credential.patch', gitPath: 'src/a' }] }]) {
    const result = project({ ...operation, manifest: Buffer.from(JSON.stringify(changed)).toString('base64') });
    assert(result.kind === 'gitArtifactProjectionError');
    assert(result.message.includes('manifest does not match') || result.message.includes('relative path is unsafe'));
  }
  const invalid = project({ ...operation, snapshotDir: 'invalid' });
  assert.equal(invalid.kind, 'gitArtifactProjectionError');
  const replaced = project({ ...operation, snapshotDirectoryPath: '/different' });
  assert.equal(replaced.kind, 'gitArtifactProjectionError');
});
