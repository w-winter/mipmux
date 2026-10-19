import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeResult, type NativeOperation } from '../src/contracts/native.js';
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: Type.Object({ ref: Type.String(), detail: Type.String(),
  contextLines: Type.Integer(), detectRenames: Type.Boolean() }), metadata: Type.String(), numstat: Type.String(), nameStatus: Type.String(),
  patch: Type.String(), expectedCommands: Type.Array(Type.Array(Type.String())), expected: Type.Unknown() })));
const prepared = Compile(Type.Object({ kind: Type.Literal('gitShowArguments'), ref: Type.String(), metadata: Type.Array(Type.String()),
  numstat: Type.Array(Type.String()), nameStatus: Type.Array(Type.String()), patch: Type.Union([Type.Array(Type.String()), Type.Null()]) }));
const envelope = Compile(Type.Object({ result: NativeResult }));
test('native show command phases and DTOs retain original RPCE metadata, stats, detail and complete hunk behavior', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-git-show/cases.json', 'utf8')));
  const proof: unknown[] = [];
  const call = (operation: Extract<NativeOperation, { kind: 'prepareGitShow' | 'parseGitShowMetadata' | 'projectGitShow' }>) => {
    const generation = 'git-show-reference';
    const nativeFrame = callNative(operation, generation, 'show');
    return envelope.Parse(nativeFrame).result;
  };
  for (const entry of cases) {
    const args = prepared.Parse(call({ kind: 'prepareGitShow', ...entry.input }));
    const commands = [[...args.metadata, args.ref], ...[args.numstat, args.nameStatus, ...(args.patch ? [args.patch] : [])]
      .map(prefix => [...prefix.filter(arg => arg !== '--no-textconv'), args.ref + '^!', '--'])];
    if (entry.name !== 'malformed-metadata') assert.deepEqual(commands, entry.expectedCommands, entry.name);
    else assert.deepEqual(commands[0], entry.expectedCommands[0]);
    assert(args.numstat.includes('--no-textconv')); assert(args.nameStatus.includes('--no-textconv'));
    if (args.patch) assert(args.patch.includes('--no-textconv'));
    const metadata = call({ kind: 'parseGitShowMetadata', bytes: Buffer.from(entry.metadata).toString('base64') });
    const parsed = metadata;
    assert(parsed.kind === 'gitShowError' || parsed.kind === 'gitShowMetadata');
    const result = parsed.kind === 'gitShowError' ? parsed : call({ kind: 'projectGitShow', detail: entry.input.detail,
      metadata: parsed.commit, numstat: Buffer.from(entry.numstat).toString('base64'),
      nameStatus: Buffer.from(entry.nameStatus).toString('base64'), patch: args.patch ? Buffer.from(entry.patch).toString('base64') : null });
    assert.deepEqual(result, entry.expected, entry.name);
    proof.push({ name: entry.name, arguments: args, result });
  }
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/reference-git-show-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
