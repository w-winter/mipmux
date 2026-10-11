import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { prepareText } from '../src/exploration/lines.js';
import { pageResult, serializedBytes } from '../src/exploration/output-budget.js';

test('line spans preserve UTF-8 bytes and terminators', () => {
  const bytes = Buffer.from('\uFEFFé🙂\r\ne\u0301\rfinal\n');
  const prepared = prepareText(bytes);
  assert.equal(prepared.lines.length, 3);
  assert.equal(prepared.searchText, '\uFEFFé🙂\ne\u0301\nfinal\n');
  assert.equal(prepareText(Buffer.alloc(0)).lines.length, 0);
  assert.throws(() => prepareText(Buffer.from([255])), /decodeFailed/);
  assert.throws(() => prepareText(Buffer.from('a\0b')), /binarySource/);
  fc.assert(fc.property(fc.string(), value => {
    const bytes = Buffer.from(value.replaceAll('\0', ''));
    const prepared = prepareText(bytes);
    assert.equal(prepared.lines.map(line => line.text).join(''), bytes.toString());
  }));
});

test('serialized pages count metadata, progress or diagnose an oversized record', () => {
  const records = ['é'.repeat(100), 'b'.repeat(200), 'third'];
  const render = (items: readonly string[], next: number | null) => ({ kind: 'page', items, next });
  const full = pageResult(records, 0, 1000, render);
  assert.deepEqual(full, render(records, null));
  assert.deepEqual(pageResult(records, 0, serializedBytes(full), render), full);
  const first = pageResult(records, 0, 300, render);
  assert('next' in first && first.next === 1);
  assert(serializedBytes(first) <= 300);
  assert.equal(pageResult(records, 0, 180, render).kind, 'recordTooLarge');
  assert.equal(pageResult(records, 0, 1, render).kind, 'outputBudgetTooSmall');
  fc.assert(fc.property(fc.array(fc.string()), fc.integer({ min: 1, max: 2000 }), (items, cap) => {
    const page = pageResult(items, 0, cap, render);
    assert(page.kind === 'outputBudgetTooSmall' || serializedBytes(page) <= cap);
  }));
});
