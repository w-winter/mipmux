import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('attachment evidence checks the whole constructed input and rejects middle omissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'smip-attachment-'));
  const context = join(directory, 'context.md'), captured = join(directory, 'captured.txt');
  const dispatch = join(directory, 'dispatch.txt'), receipt = join(directory, 'receipt.json');
  const body = '\uFEFFBEGIN\r\n' + 'public evidence 🙂\n'.repeat(5000) + '<user_instructions>Complete task</user_instructions>';
  writeFileSync(context, body); writeFileSync(dispatch, 'Inspect the attached packet.');
  const expected = `<file name="${context}">\n${body.slice(1)}\n</file>\nInspect the attached packet.`;
  writeFileSync(captured, expected);
  const command = resolve('scripts/verify-live.mjs');
  execFileSync(process.execPath, [command, 'attachment', context, captured, dispatch, receipt]);
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).completeAttachment, true);
  writeFileSync(captured, expected.replace('public evidence 🙂\n'.repeat(100), ''));
  assert.throws(() => execFileSync(process.execPath, [command, 'attachment', context, captured, dispatch, join(directory, 'invalid.json')], { stdio: 'pipe' }));
});
