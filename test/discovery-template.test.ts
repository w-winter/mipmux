import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import fc from 'fast-check';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { callNative } from './fixtures/call-native.js';
import type { NativeOperation } from '../src/contracts/native.js';

const template = readFileSync('test/fixtures/discovery-template.md', 'utf8');
const policy = Compile(Type.Object({ kind: Type.Literal('discoveryPrompt'), text: Type.String(), message: Type.String() }));
const rejection = Compile(Type.Object({ kind: Type.Literal('discoveryTemplateRejected'), diagnostic: Type.Unknown() }));
const operation: Extract<NativeOperation, { kind: 'renderDiscoveryPrompt' }> = {
  kind: 'renderDiscoveryPrompt', template, tokenBudget: 198500, enhancementMode: 'fullRewrite', codemode: false,
  purpose: 'investigation', task: '', allowClarifyingQuestions: false, questionTimeoutSeconds: 300,
  restrictsReviewGitToExplicitReadOnly: false, reviewRootNames: [], fileTree: '', currentPrompt: '', discoveryInstructions: '',
};
const inactiveSection = '<!-- mipmux:section mode.preserve.checklist -->';

test('valid editable template composition returns its exact repeated body', () => {
  const frame = callNative(operation, 'template-valid', 'valid');
  const result = policy.Parse(frame.result);
  assert.equal(result.text, 'L|BODY_LITERAL|BODY_LITERAL|R');
});

test('invalid templates return correlated domain rejections, including inactive sections', () => {
  const invalid = [
    { name: 'header', template: template.replace('# mipmux discovery template v1', 'UNRECOGNIZED_HEADER_CONTENT') },
    { name: 'missing', template: template.replace(inactiveSection + '\n<!-- mipmux:end -->\n', '') },
    { name: 'duplicate', template: template + '\n' + inactiveSection + '\n<!-- mipmux:end -->\n' },
    { name: 'unknown', template: template + '\n<!-- mipmux:section unknown -->\n<!-- mipmux:end -->\n' },
    { name: 'nested', template: template.replace('<!-- mipmux:section system -->', '<!-- mipmux:section system -->\n<!-- mipmux:section startup.metadata -->') },
    { name: 'unmatched-end', template: template + '\n<!-- mipmux:end -->\n' },
    { name: 'unclosed-section', template: template.slice(0, template.lastIndexOf('<!-- mipmux:end -->')) },
    { name: 'outside', template: template.replace('# mipmux discovery template v1\n', '# mipmux discovery template v1\nOutside section\n') },
    { name: 'malformed-marker', template: template.replace('<!-- mipmux:section system -->', '<!-- mipmux:section system-- >') },
    ...[
      { name: 'unknown-placeholder', value: '{{mipmux:unknown}}' },
      { name: 'unclosed-placeholder', value: '{{mipmux:token_budget' },
      { name: 'malformed-placeholder', value: '{{mipmuxtoken_budget}}' },
      { name: 'section-slot-in-leaf', value: '{{mipmux:review_root_guidance}}' },
      { name: 'root-scalar-outside-named-roots', value: '{{mipmux:root_names}}' },
    ].map(({ name, value }) => ({ name, template: template.replace(inactiveSection, inactiveSection + '\n' + value) })),
  ];
  const proof = [];
  for (const { name, template: invalidTemplate } of invalid) {
    const frame = callNative({ ...operation, template: invalidTemplate }, 'template-invalid', name);
    const result = rejection.Parse(frame.result);
    assert(!JSON.stringify(result).includes('UNRECOGNIZED_HEADER_CONTENT'));
    if (name === 'header') {
      const diagnostic = Compile(Type.Object({ kind: Type.Literal('header'), line: Type.Literal(1) }));
      diagnostic.Parse(result.diagnostic);
    }
    proof.push({ name, result });
  }
  writeFileSync('test-output/discovery-template-rejections.json', JSON.stringify(proof, null, 2) + '\n');
});

test('edited template bodies retain literal UTF-8 bytes through reordered definitions and repeated insertions', () => {
  const header = '# mipmux discovery template v1\n\n';
  const reordered = header + template.slice(header.length).trimEnd().split('\n\n').reverse().join('\n\n') + '\n';
  const examples: [string][] = [[''], [' \t '], ['\nA\n'], ['A\r\nB'], ['e\u0301'], ['{"outer":{"value":1}}']];
  const proof: { body: string; expectedBase64: string; actualBase64: string }[] = [];
  fc.assert(fc.property(fc.string({ unit: 'grapheme' }).filter(body => !body.includes('<!-- mipmux:') && !body.includes('{{mipmux')), body => {
    // A replacer function inserts the body literally; a replacement string would expand `$` patterns such as `$$`.
    const input = reordered.replace('\nBODY_LITERAL\n', () => '\n' + body + '\n');
    const frame = callNative({ ...operation, template: input }, 'template-bytes', 'literal-' + proof.length);
    const result = policy.Parse(frame.result);
    const expected = Buffer.from('L|' + body + '|' + body + '|R');
    const actual = Buffer.from(result.text);
    assert(actual.equals(expected));
    proof.push({ body, expectedBase64: expected.toString('base64'), actualBase64: actual.toString('base64') });
  }), { examples });
  writeFileSync('test-output/discovery-template-bytes.json', JSON.stringify(proof, null, 2) + '\n');
});

test('runtime task and hints remain literal while explicit timeout substitution uses the admitted value', () => {
  const questionTimeoutSeconds = 47;
  const timeoutTemplate = template.replace('L|{{mipmux:handoff}}|{{mipmux:handoff}}|R', '{{mipmux:question_timeout_seconds}}');
  const currentPrompt = 'Original\r\n{{mipmux:unknown}}\n<!-- mipmux:section unknown -->\ne\u0301';
  const discoveryInstructions = 'Hints {{mipmux:token_budget}} <!-- mipmux:end -->';
  const frame = callNative({ ...operation, template: timeoutTemplate, questionTimeoutSeconds, currentPrompt, discoveryInstructions }, 'template-runtime', 'literal');
  const result = policy.Parse(frame.result);
  assert.equal(result.text, String(questionTimeoutSeconds));
  assert(Buffer.from(result.message).includes(Buffer.from(currentPrompt)));
  assert(Buffer.from(result.message).includes(Buffer.from(discoveryInstructions)));
});
