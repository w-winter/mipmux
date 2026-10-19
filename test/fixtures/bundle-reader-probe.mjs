import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../../dist-test/src/index.js';
import { copyContext } from '../../dist-test/test/fixtures/copy-context.js';

const [directory, mode, scenario, component] = process.argv.slice(2);
const originalOpen = fs.open, originalReadFile = fs.readFile;
const handles = [];
let boundary = false;
const enter = () => { if (!boundary) { boundary = true; process.send({ kind: 'boundary' }); } };
const hold = options => new Promise((_, reject) => {
  enter();
  const signal = options?.signal;
  if (signal?.aborted) reject(signal.reason);
  else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});
fs.open = async (path, ...args) => {
  if (String(path) === join(directory, component) && scenario === 'fifo') enter();
  const file = await originalOpen(path, ...args);
  handles.push(file);
  if (String(path) === join(directory, component)) {
    const read = file.readFile.bind(file);
    file.readFile = options => {
      if (scenario === 'cancel' || scenario === 'shutdown') return hold(options);
      if (scenario === 'readFailure') { enter(); return Promise.reject(Object.assign(new Error('read failure'), { code: 'EIO' })); }
      return read(options);
    };
  }
  return file;
};
fs.readFile = (path, ...args) => {
  if (String(path) === join(directory, component)) {
    if (scenario === 'fifo') enter();
    if (scenario === 'cancel' || scenario === 'shutdown') return hold(args[0]);
    if (scenario === 'readFailure') { enter(); return Promise.reject(Object.assign(new Error('read failure'), { code: 'EIO' })); }
  }
  return originalReadFile(path, ...args);
};
syncBuiltinESMExports();
const abort = new AbortController();
const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'unused-cache'), nativeExecutable: '/unavailable-native',
  nativeEnvironment: {}, contextBudgetUnits: 1000000, credentialPaths: [], terminationGraceMs: 0 });
let closing = null;
process.on('message', async message => {
  if (message === 'cancel') abort.abort();
  else if (message === 'shutdown') closing = runtime.close();
  else if (message === 'go') {
    let outcome;
    try {
      const result = mode === 'integrity' ? await verifyBundle(directory) : await verifyCurrentBundle(directory, runtime, abort.signal);
      outcome = { kind: result.kind };
    } catch (error) { outcome = { kind: 'rejected', code: error.code ?? error.name, name: error.name }; }
    await closing;
    await runtime.close();
    process.send({ kind: 'result', outcome, opened: handles.length, closed: handles.every(file => file.fd === -1) }, () => process.disconnect());
  }
});
process.send({ kind: 'ready' });
