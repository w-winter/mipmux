import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { NativeOperation } from '../src/contracts/native.js';

type ScopeOperation = Extract<NativeOperation, { kind: 'parseSearchScope' | 'refreshSearchScope' }>;

function request(operation: ScopeOperation) {
  const generation = 'scope-parser';
  const frame = callNative(operation, generation, 'scope');
  if (frame.kind !== 'terminal' || frame.result.kind !== 'searchScopeParsed') assert.fail('Missing parsed scope');
  return frame.result.scope;
}

test('native raw scopes use catalog ownership, source ambiguity and exact-clause refresh', async () => {
  const a = { id: '00000000-0000-0000-0000-000000000001', name: 'Alpha', path: '/workspace/a',
    files: ['src/main.swift', 'src/nested/child.swift', 'shared.swift'].map(path => ({ path, discoverable: true })),
    directories: ['src', 'src/nested'].map(path => ({ path, discoverable: true })) };
  const b = { id: '00000000-0000-0000-0000-000000000002', name: 'Beta', path: '/workspace/b',
    files: [{ path: 'shared.swift', discoverable: true }], directories: [] };
  const nested = { id: '00000000-0000-0000-0000-000000000003', name: 'Nested', path: '/workspace/a/src',
    files: [{ path: 'main.swift', discoverable: true }], directories: [] };
  const roots = [a, b, nested];
  const parse = (paths: string[]) => request({ kind: 'parseSearchScope', roots, paths, caseInsensitive: true });
  const observations: unknown[] = [];
  const exact = parse([' Alpha/src/main.swift ', 'src/main.swift']);
  assert.deepEqual(exact.spec.clauses, [{ kind: 'exactFile', absPath: '/workspace/a/src/main.swift',
    relPath: 'src/main.swift', restrictedRootPath: '/workspace/a' }]);
  assert.deepEqual(exact.exactClauses, [{ clauseIndex: 0, rootID: a.id, relativePath: 'src/main.swift', missingClauses: [
    { kind: 'prefix', candidateLower: 'alpha/src/main.swift' }, { kind: 'prefix', candidateLower: 'src/main.swift' },
  ] }]);
  assert.deepEqual(exact.freshnessRootRefs.map(root => root.id), [a.id]);
  observations.push({ exact });
  const absolute = parse(['/workspace/a/src/main.swift']);
  assert.deepEqual(absolute.spec.clauses, [{ kind: 'exactFile', absPath: '/workspace/a/src/main.swift',
    relPath: 'main.swift', restrictedRootPath: '/workspace/a/src' }]);
  assert.deepEqual(absolute.freshnessRootRefs.map(root => root.id), [nested.id]);
  const folder = parse(['Alpha/src']);
  assert.deepEqual(folder.spec.clauses, [{ kind: 'prefix', candidateLower: 'alpha/src' }]);
  const absoluteFolder = parse(['/workspace/a/src']);
  assert.deepEqual(absoluteFolder.spec.clauses, [{ kind: 'exactFolder', absLower: '/workspace/a/src',
    relLower: '', restrictedRootPath: '/workspace/a/src' }]);
  const globs = parse(['ALPHA/src/*.swift', '/workspace/a/src/*.swift']);
  assert.deepEqual(globs.spec.clauses, [{ kind: 'glob', pattern: 'src/*.swift', restrictedRootPath: '/workspace/a' },
    { kind: 'glob', pattern: '*.swift', restrictedRootPath: '/workspace/a/src' }]);
  assert.deepEqual(globs.freshnessRootRefs.map(root => root.id), [a.id, nested.id]);
  const missing = parse(['unknown-component/not-present-9375']);
  assert.deepEqual(missing.spec.clauses, [{ kind: 'prefix', candidateLower: 'unknown-component/not-present-9375' }]);
  assert.deepEqual(missing.freshnessRootRefs.map(root => root.id), roots.map(root => root.id));
  const ambiguous = parse(['shared.swift']);
  assert.deepEqual(ambiguous.spec.clauses, []);
  assert.match(ambiguous.issues[0]!, /matches multiple workspace roots/);
  const alias = request({ kind: 'parseSearchScope', roots: [a, { ...b, name: 'ALPHA' }], paths: ['Alpha/*.swift'], caseInsensitive: false });
  assert.deepEqual(alias.spec.clauses, []); assert.match(alias.issues[0]!, /Ambiguous root alias/);
  observations.push({ absolute, folder, absoluteFolder, globs, missing, ambiguous, alias });
  const disappeared = request({ kind: 'refreshSearchScope', roots: [{ ...a,
    files: a.files.filter(file => file.path !== 'src/main.swift') }, b, nested], scope: exact });
  assert.deepEqual(disappeared.spec.clauses, exact.exactClauses[0]!.missingClauses);
  assert.deepEqual(disappeared.exactClauses, []);
  assert.deepEqual(disappeared.freshnessRootRefs, exact.freshnessRootRefs);
  const changedKind = request({ kind: 'refreshSearchScope', roots: [{ ...a,
    files: a.files.filter(file => file.path !== 'src/main.swift'),
    directories: [...a.directories, { path: 'src/main.swift', discoverable: true }] }, b, nested], scope: exact });
  assert.deepEqual(changedKind.spec.clauses, [{ kind: 'exactFolder', absLower: '/workspace/a/src/main.swift',
    relLower: 'src/main.swift', restrictedRootPath: '/workspace/a' }]);
  assert.deepEqual(changedKind.exactClauses, []);
  observations.push({ disappeared, changedKind });
  for (const exactClauses of [
    [{ ...exact.exactClauses[0]!, clauseIndex: exact.spec.clauses.length }],
    [exact.exactClauses[0]!, exact.exactClauses[0]!],
  ]) {
    const malformed = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), ['scope-parser'], {
      input: JSON.stringify({ wireVersion: 1, requestId: 'invalid-scope', generation: 'scope-parser',
        operation: { kind: 'refreshSearchScope', roots, scope: { ...exact, exactClauses } } }) + '\n', encoding: 'utf8',
    });
    assert.equal(malformed.status, 1); assert.equal(malformed.stdout, '');
    assert.deepEqual(JSON.parse(malformed.stderr), { level: 'error', code: 'nativeProtocolError' });
    observations.push({ malformed: exactClauses, status: malformed.status });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/search-scope-parsing.json', JSON.stringify(observations, null, 2) + '\n');
});
