import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('discoveryPrompt'), text: Type.String(),
}) }));

test('native RPCE factory preserves all three rendered mode branches against the original source outputs', async () => {
  const proof: { mode: string; bytes: number }[] = [];
  for (const mode of ['fullRewrite', 'augment', 'preserve']) {
    const generation = 'prompt-reference';
    const call = { wireVersion: 1, requestId: mode, generation, operation: { kind: 'renderDiscoveryPrompt',
      tokenBudget: 198500, runtime: 'codexExec', enhancementMode: mode, allowClarifyingQuestions: false,
      responseType: 'review', instructions: null, questionTimeoutSeconds: 300,
      restrictsReviewGitToExplicitReadOnly: false, reviewRootNames: [] } };
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation],
      { input: JSON.stringify(call) + '\n', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n');
    assert.equal(frames.length, 1, 'Factory diagnostics must not corrupt the native wire');
    const rendered = reply.Parse(JSON.parse(frames[0]!)).result.text;
    const reference = await readFile(resolve(`test/fixtures/rpce-discovery/${mode}.md`), 'utf8');
    const normalized = rendered.replace(/^\*\*Codemap coverage:\*\* .+$/m, '**Codemap coverage:** __SUPPORTED_LANGUAGES__');
    assert.equal(normalized, reference, mode);
    proof.push({ mode, bytes: Buffer.byteLength(rendered) });
  }
  await writeFile(resolve('test-output/reference-prompt-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
