import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeDiscoveryMessageInput } from '../src/contracts/native.js';

const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: NativeDiscoveryMessageInput, expected: Type.String() })));
const reply = Compile(Type.Object({ kind: Type.Literal('terminal'), result: Type.Object({
  kind: Type.Literal('discoveryMessage'), text: Type.String(),
}) }));

const sourceCompressionClaim = '- For MCP modes (like the current context_builder mode), selected files are automatically compressed to show only their codemaps (API signatures) instead of full content, dramatically reducing token usage';
const representationGuidance = '- Selected files use full content, slices, or codemaps (API signatures), according to their selected representation';

test('native startup renderer preserves RPCE ordering with the approved representation guidance correction', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile(resolve('test/fixtures/rpce-discovery-message/cases.json'), 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  for (const entry of cases) {
    const generation = 'startup-reference';
    const result = spawnSync(resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), [generation], {
      input: JSON.stringify({ wireVersion: 1, requestId: entry.name, generation, operation: entry.input }) + '\n', encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const frames = result.stdout.trim().split('\n');
    assert.equal(frames.length, 1, 'Meta prompts must not be printed to the native protocol stdout');
    const rendered = reply.Parse(JSON.parse(frames[0]!)).result.text;
    assert.equal(rendered, entry.expected.replace(sourceCompressionClaim, representationGuidance), entry.name);
    proof.push({ name: entry.name, bytes: Buffer.byteLength(rendered) });
  }
  await writeFile(resolve('test-output/reference-discovery-message-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});
