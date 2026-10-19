import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import type { NativeOperation, NativeRequest } from '../src/contracts/native.js';

const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('discoveryPrompt'), text: Type.String(),
}) }));

test('native RPCE factory preserves all three rendered mode branches against the original source outputs', async () => {
  const proof: { mode: string; bytes: number }[] = [];
  const modes: Extract<NativeOperation, { kind: 'renderDiscoveryPrompt' }>['enhancementMode'][] = ['fullRewrite', 'augment', 'preserve'];
  for (const mode of modes) {
    const generation = 'prompt-reference';
    const call: NativeRequest = { wireVersion: 1, requestId: mode, generation, operation: { kind: 'renderDiscoveryPrompt',
      tokenBudget: 198500, runtime: 'codexExec', enhancementMode: mode, allowClarifyingQuestions: false,
      responseType: 'review', instructions: null, questionTimeoutSeconds: 300,
      restrictsReviewGitToExplicitReadOnly: false, reviewRootNames: [] } };
    const nativeFrame = callNative(call.operation, generation, mode);
    const rendered = reply.Parse(nativeFrame).result.text;
    const reference = await readFile(resolve(`test/fixtures/rpce-discovery/${mode}.md`), 'utf8');
    const normalized = rendered.replace(/^\*\*Codemap coverage:\*\* .+$/m, '**Codemap coverage:** __SUPPORTED_LANGUAGES__');
    assert.equal(normalized, reference, mode);
    proof.push({ mode, bytes: Buffer.byteLength(rendered) });
  }
  await writeFile(resolve('test-output/reference-prompt-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
