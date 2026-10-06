import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageResult, serializedBytes } from '../src/exploration/output-budget.js';
import { failureResult, toolResult } from '../src/runtime/tool-result.js';
import { WorkspaceFailure } from '../src/workspace/values.js';

test('adapter caps include escaped text and structured results, and diagnostics make progress', () => {
  const records = ['"\\🙂'.repeat(70), 'second'];
  const render = (items: readonly string[], next: number | null) => ({ kind: 'page', items, next });
  const cap = serializedBytes(toolResult(render(records.slice(0, 1), 1)));
  const page = pageResult(records, 0, cap, render, toolResult);
  assert.deepEqual(page, render(records.slice(0, 1), 1));
  assert.equal(serializedBytes(toolResult(page)), cap);
  const tooSmall = pageResult(records, 0, 1, render, toolResult);
  assert.equal(tooSmall.kind, 'outputBudgetTooSmall');
});

test('adapter errors retain revision and required size without arbitrary diagnostic payloads', () => {
  assert.deepEqual(failureResult(new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes: 1000, body: 'private' })),
    { kind: 'outputBudgetTooSmall', requiredBytes: 1000 });
  assert.deepEqual(failureResult(new WorkspaceFailure('revisionConflict', { revision: 4, body: 'private' })),
    { kind: 'error', code: 'revisionConflict', revision: 4 });
  assert.deepEqual(failureResult(new Error('private provider response')), { kind: 'error', code: 'operationFailed' });
});
