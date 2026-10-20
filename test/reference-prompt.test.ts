import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('discoveryPrompt'), text: Type.String(),
}) }));
const cases = Compile(Type.Array(Type.Object({ name: Type.String(), expected: Type.String(), input: Type.Object({
  tokenBudget: Type.Integer(), enhancementMode: Type.Union([Type.Literal('fullRewrite'), Type.Literal('augment'), Type.Literal('preserve')]),
  allowClarifyingQuestions: Type.Boolean(), responseType: Type.Union([Type.Literal('clarify'), Type.Literal('review')]),
  questionTimeoutSeconds: Type.Integer(), restrictsReviewGitToExplicitReadOnly: Type.Boolean(), reviewRootNames: Type.Array(Type.String()),
}) })));

test('the shipped editable template preserves independent original-policy mode, clarification and review variants', async () => {
  const template = await readFile('prompts/discovery.md', 'utf8');
  const references = cases.Parse(JSON.parse(await readFile('test/fixtures/mipmux-discovery-policy/cases.json', 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  for (const entry of references) {
    const nativeFrame = callNative({ kind: 'renderDiscoveryPrompt', template,
      tokenBudget: entry.input.tokenBudget, enhancementMode: entry.input.enhancementMode,
      allowClarifyingQuestions: entry.input.allowClarifyingQuestions,
      purpose: entry.input.responseType === 'review' ? 'review' : 'investigation', task: '',
      questionTimeoutSeconds: entry.input.questionTimeoutSeconds,
      restrictsReviewGitToExplicitReadOnly: entry.input.restrictsReviewGitToExplicitReadOnly,
      reviewRootNames: entry.input.reviewRootNames, fileTree: '', currentPrompt: '', discoveryInstructions: '',
    }, 'prompt-reference', entry.name);
    const rendered = reply.Parse(nativeFrame).result.text;
    const normalized = rendered.replace(/^\*\*Codemap coverage:\*\* .+$/m, '**Codemap coverage:** __SUPPORTED_LANGUAGES__');
    assert.equal(normalized, entry.expected, entry.name);
    proof.push({ name: entry.name, bytes: Buffer.byteLength(rendered) });
  }
  await writeFile(resolve('test-output/reference-prompt-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});

test('review purpose, phrase hotwords and separated git/diffs tokens retain their original distinctions', async () => {
  const template = await readFile('prompts/discovery.md', 'utf8');
  const references = cases.Parse(JSON.parse(await readFile('test/fixtures/mipmux-discovery-policy/cases.json', 'utf8')));
  for (const input of [
    { purpose: 'review', task: 'Gather dependencies', review: true },
    { purpose: 'planning', task: 'Prepare a code review', review: true },
    { purpose: 'investigation', task: 'Prepare a code review', review: true },
    { purpose: 'planning', task: 'Inspect git metadata and diffs', review: true },
    { purpose: 'investigation', task: 'Inspect git metadata and diffs', review: true },
    { purpose: 'planning', task: 'Please review architecture', review: false },
    { purpose: 'investigation', task: 'Please review architecture', review: false },
  ] as const) {
    const reference = references.find(entry => entry.name === 'fullRewrite-noninteractive-' + (input.review ? 'readOnlyNamed' : 'none'));
    assert(reference);
    const frame = callNative({ kind: 'renderDiscoveryPrompt', template, tokenBudget: 198500,
      enhancementMode: 'fullRewrite', purpose: input.purpose, task: input.task, allowClarifyingQuestions: false,
      questionTimeoutSeconds: 300, restrictsReviewGitToExplicitReadOnly: true, reviewRootNames: ['mipmux', 'repoprompt-ce'],
      fileTree: '', currentPrompt: '', discoveryInstructions: '',
    }, 'review-intent', input.purpose + '-' + input.task);
    const rendered = reply.Parse(frame).result.text.replace(/^\*\*Codemap coverage:\*\* .+$/m, '**Codemap coverage:** __SUPPORTED_LANGUAGES__');
    assert.equal(rendered, reference.expected, input.purpose + ': ' + input.task);
  }
});
