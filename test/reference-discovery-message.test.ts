import { callNative } from './fixtures/call-native.js';
import { bindToolNames } from '../src/context/discovery-input.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({
  kind: Type.Literal('renderDiscoveryMessage'), tokenBudget: Type.Integer(), fileTree: Type.String(),
  currentPrompt: Type.String(), discoveryInstructions: Type.String(),
  contextBuilderPrompts: Type.Array(Type.Object({ title: Type.String(), content: Type.String() })),
}), expected: Type.String() })));
const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('discoveryPrompt'), message: Type.String(),
}) }));

const sourceCompressionClaim = '- For MCP modes (like the current context_builder mode), selected files are automatically compressed to show only their codemaps (API signatures) instead of full content, dramatically reducing token usage';
const representationGuidance = '- Selected files use full content, slices, or codemaps (API signatures), according to their selected representation';

test('native startup renderer preserves RPCE ordering with the approved representation guidance correction', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-discovery-message/cases.json'), 'utf8')));
  const template = bindToolNames(await readFile('prompts/discovery.md', 'utf8'), '');
  const proof: { name: string; bytes: number }[] = [];
  for (const entry of cases.filter(entry => entry.input.contextBuilderPrompts.length === 0)) {
    const generation = 'startup-reference';
    const nativeFrame = callNative({ kind: 'renderDiscoveryPrompt', template, tokenBudget: entry.input.tokenBudget,
      enhancementMode: 'preserve', codemode: true, purpose: 'investigation', task: entry.input.currentPrompt,
      allowClarifyingQuestions: false, questionTimeoutSeconds: 300, restrictsReviewGitToExplicitReadOnly: true,
      reviewRootNames: [], fileTree: entry.input.fileTree, currentPrompt: entry.input.currentPrompt,
      discoveryInstructions: entry.input.discoveryInstructions }, generation, entry.name);
    const rendered = reply.Parse(nativeFrame).result.message;
    assert.equal(rendered, entry.expected.replace(sourceCompressionClaim, representationGuidance), entry.name);
    proof.push({ name: entry.name, bytes: Buffer.byteLength(rendered) });
  }
  await writeFile(resolve('test-output/reference-discovery-message-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
