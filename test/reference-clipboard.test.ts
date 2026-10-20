import { callNative } from './fixtures/call-native.js';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { NativeClipboardInput } from '../src/contracts/native.js';

const sourceSection = Type.Enum(['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions']);
const sourceInput = Type.Object({ ...Type.Omit(NativeClipboardInput.properties.input,
  ['constraints', 'promptSectionsOrder', 'disabledPromptSections']).properties,
  metaInstructions: Type.Array(Type.Object({ title: Type.String(), content: Type.String() })), includeSavedPrompts: Type.Boolean(),
  promptSectionsOrder: Type.Array(sourceSection), disabledPromptSections: Type.Array(sourceSection) });
const fixtures = Compile(Type.Array(Type.Object({ name: Type.String(), input: sourceInput,
  expected: Type.Object({ kind: Type.Literal('clipboard'), text: Type.String(), utf8Bytes: Type.Integer(), sha256: Type.String() }),
})));
const reply = Compile(Type.Object({ result: Type.Unknown() }));

test('native clipboard packaging preserves applicable original map, content, Git and user sections', async () => {
  const cases = fixtures.Parse(JSON.parse(await readFile('test/fixtures/rpce-clipboard/cases.json', 'utf8')));
  const proof: { name: string; bytes: number }[] = [];
  const applicable = cases.filter(fixture => !fixture.input.includeSavedPrompts || fixture.input.metaInstructions.length === 0 ||
    fixture.input.disabledPromptSections.includes('metaPrompts'));
  for (const fixture of applicable) {
    const generation = 'clipboard';
    const { metaInstructions: _sourceMetas, includeSavedPrompts: _sourceFlag,
      promptSectionsOrder, disabledPromptSections, ...input } = fixture.input;
    const nativeFrame = callNative({ kind: 'renderClipboard', input: { ...input, constraints: '',
      promptSectionsOrder: promptSectionsOrder.map(section => section === 'metaPrompts' ? 'constraints' : section),
      disabledPromptSections: disabledPromptSections.map(section => section === 'metaPrompts' ? 'constraints' : section),
    } }, generation, fixture.name);
    assert.deepEqual(reply.Parse(nativeFrame).result,
      { kind: 'clipboard', text: fixture.expected.text }, fixture.name);
    assert.equal(Buffer.byteLength(fixture.expected.text), fixture.expected.utf8Bytes, fixture.name);
    proof.push({ name: fixture.name, bytes: fixture.expected.utf8Bytes });
  }
  await writeFile('test-output/reference-clipboard-proof.json', JSON.stringify(proof, null, 2) + '\n');
});
