import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeOperation, AutomaticReviewGitCompleteness } from '../src/contracts/native.js';
import { BridgeClient } from '../src/native/bridge-client.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { verifyAutomaticReviewGitCapture } from '../src/context/automatic-review-git-integrity.js';
import { sha256 } from '../src/workspace/values.js';

test('native automatic Review rendering matches original RPCE coordinator observations', async () => {
  const validator = Compile(Type.Object({ cases: Type.Array(Type.Object({ name: Type.String(), operation: NativeOperation,
    expected: Type.Object({ text: Type.Union([Type.String(), Type.Null()]), completeness: AutomaticReviewGitCompleteness,
      outcomeKinds: Type.Array(Type.String()) }) })) }));
  const raw: unknown = JSON.parse(await readFile(resolve('test/fixtures/rpce-automatic-review-git.json'), 'utf8'));
  assert(validator.Check(raw));
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const bridge = new BridgeClient({ executable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`),
    env: {}, supervisor });
  try {
    for (const fixture of raw.cases) {
      assert(fixture.operation.kind === 'renderAutomaticReviewGit');
      const { result } = await bridge.request(fixture.operation, new AbortController().signal);
      assert.deepEqual({ text: result.text, completeness: result.completeness, outcomeKinds: result.outcomes.map(outcome => outcome.kind) },
        fixture.expected, fixture.name);
    }
    const checkout = { identity: { root: 'r', checkoutRootPath: '/r/子\n目录', repoKey: 'fixture', repositoryID: 'fixture',
      worktreeID: 'fixture', kind: 'canonical' as const }, displayLabel: 'Workspace/子\n目录', selectedPaths: ['/r/子\n目录/file'] };
    const comparison = { head: '1'.repeat(40), base: '1'.repeat(40) };
    const { result } = await bridge.request({ kind: 'renderAutomaticReviewGit', outcomes: [
      { kind: 'diff', checkout, text: '\nPATCH 🙂\n\n' }, { kind: 'noChanges', checkout: { ...checkout, displayLabel: 'Other' } },
    ], pathIssues: [] }, new AbortController().signal);
    assert.equal(result.text, '===== BEGIN REPOPROMPT CHECKOUT DIFF: Workspace/子\n目录 =====\nPATCH 🙂\n' +
      '===== END REPOPROMPT CHECKOUT DIFF: Workspace/子\n目录 =====');
    const span = result.bodySpans[0]; assert(span); assert(result.text);
    const body = Buffer.from(result.text).subarray(span.offset, span.offset + span.length);
    assert.equal(body.toString(), 'PATCH 🙂');
    verifyAutomaticReviewGitCapture({ text: result.text, evidence: { scope: 'selected', rootBinding: null, completeness: result.completeness, sourceRoots: [{ root: 'r', path: '/r' }], pathIssues: [], outcomes: [
      { kind: 'diff', checkout, comparison, body: { ...span, sha256: sha256(body) } },
      { kind: 'noChanges', checkout: { ...checkout, displayLabel: 'Other' }, comparison },
    ] } }, true);
  } finally { await bridge.close(); await supervisor.close(); }
});
