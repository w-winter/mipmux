import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compile } from 'typebox/compile';
import fc from 'fast-check';
import { RelativePath } from '../src/contracts/workspace.js';
import { NativeWireFailureCode, type NativeFailureCode } from '../src/contracts/errors.js';

test('native failure schema and inferred type represent absence', () => {
  const code: NativeFailureCode = 'notFound';
  assert(Compile(NativeWireFailureCode).Check(code));
});

test('path validation distinguishes dot components from newline-bearing filenames', () => {
  const validator = Compile(RelativePath);
  for (const path of ['.\n', '..\n', 'a\n/.\n']) assert(validator.Check(path), path);
  assert(!validator.Check('a\n/../b'));
  fc.assert(fc.property(fc.string(), path => {
    const expected = path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0'));
    assert.equal(validator.Check(path), expected);
  }));
});
