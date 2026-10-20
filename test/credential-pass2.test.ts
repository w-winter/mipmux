import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCredentials } from '../src/discovery/pi-credentials.js';

test('locked credential boundary rejects malformed initial and later data before callbacks and persistence', async () => {
  await mkdir('test-output', { recursive: true }); const directory = await mkdtemp(join(tmpdir(), 'mipmux-credential-pass2-')), path = join(directory, 'synthetic.json');
  const malformed: unknown[] = [[], null, 1, 'string', true, { p: [] }, { p: null }, { p: { type: 'unknown' } },
    { p: { type: 'api_key', key: 7 } }, { p: { type: 'api_key', env: [] } }, { p: { type: 'api_key', env: { X: false } } },
    { p: { type: 'oauth', access: 17, refresh: null, expires: 'later' } }, { p: { type: 'oauth', access: 'a', refresh: 'r', expires: null } }];
  for (const value of malformed) {
    await writeFile(path, JSON.stringify(value)); await assert.rejects(createCredentials(path, new AbortController().signal), /invalidCredentialConfiguration/);
  }
  const valid = { p: { type: 'api_key', env: { X: 'value' } }, q: { type: 'api_key', key: 'synthetic' },
    oauth: { type: 'oauth', access: 'a', refresh: 'r', expires: 123, metadata: { custom: ['data', 1] } } };
  await writeFile(path, JSON.stringify(valid)); const store = await createCredentials(path, new AbortController().signal);
  assert.deepEqual(await store.read('p'), valid.p); assert.deepEqual(await store.read('oauth'), valid.oauth);
  for (const value of malformed) {
    await writeFile(path, JSON.stringify(value)); let called = false;
    await assert.rejects(store.read('p'), /invalidCredentialConfiguration/); await assert.rejects(store.list(), /invalidCredentialConfiguration/);
    await assert.rejects(store.modify('p', async current => { called = true; return current; }), /invalidCredentialConfiguration/); assert.equal(called, false);
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(value));
  }
  await writeFile(path, JSON.stringify(valid)); const before = await readFile(path);
  await assert.rejects(store.modify('oauth', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Infinity })), /invalidCredentialConfiguration/);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(store.modify('q', async () => ({ type: 'api_key', key: '!synthetic-command' })), /executableConfiguration/);
  assert.deepEqual(await readFile(path), before);
  await store.modify('oauth', async current => { assert.deepEqual(current, valid.oauth); return { ...valid.oauth, type: 'oauth', access: 'rotated' }; });
  assert.equal((await store.read('oauth'))?.type, 'oauth');
  await writeFile(join(directory, 'proof.json'), JSON.stringify({ malformedCases: malformed.length, callbacksRejected: true, invalidWritesNotPersisted: true, validMetadataRetained: true }) + '\n');
});
