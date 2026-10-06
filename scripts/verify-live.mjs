import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const [operation, contextPath, capturedPath, dispatchPath, receiptPath, ...extra] = process.argv.slice(2);
assert(operation === 'attachment' && !extra.length &&
  [contextPath, capturedPath, dispatchPath, receiptPath].every(path => typeof path === 'string' && isAbsolute(path)),
'Usage: verify-live.mjs attachment <absolute-context> <absolute-captured-user-text> <absolute-processed-dispatch-text> <absolute-new-receipt>');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const context = readFileSync(contextPath), captured = readFileSync(capturedPath), dispatch = readFileSync(dispatchPath);
const body = decoder.decode(context).replace(/^\uFEFF/u, '');
// Compare coordinator-captured input with the documented Pi CLI wrapper and processed dispatch concatenation.
const expected = Buffer.from(`<file name="${contextPath}">\n${body}\n</file>\n` + decoder.decode(dispatch));
assert(captured.equals(expected), 'Captured recipient input differs from the complete single attachment and processed dispatch.');
const identity = bytes => ({ byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const receipt = { schemaVersion: 1, completeAttachment: true, contextPath, context: identity(context),
  deliveredBody: identity(Buffer.from(body)), constructedUserInput: identity(captured), dispatch: identity(dispatch),
  processing: 'Pi CLI UTF-8 text attachment wrapper; leading BOM removed; processed CLI dispatch concatenated after wrapper.',
  evidenceLimit: 'Checks captured constructed user text. Does not independently observe backend requests or model comprehension.' };
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(receipt));
