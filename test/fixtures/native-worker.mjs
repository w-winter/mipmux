#!/usr/bin/env node
import { stdin, stdout, env, argv } from 'node:process';

stdin.once('data', bytes => {
  const request = JSON.parse(bytes.toString('utf8'));
  const frame = { wireVersion: 1, requestId: request.requestId, generation: argv[2], kind: 'terminal', result: { kind: 'unsupportedExtension' } };
  switch (env.SCENARIO) {
    case 'activeFragment': {
      const output = JSON.stringify(frame) + '\n', middle = Math.floor(output.length / 2);
      stdout.write(output.slice(0, middle));
      stdin.once('data', () => stdout.write(output.slice(middle)));
      return;
    }
    case 'idleFragment':
      stdin.once('data', () => stdout.write(env.FRAGMENT));
      break;
    case 'wrongKind': frame.result = { kind: 'directoryComplete', count: 0, sha256: '0'.repeat(64) }; break;
    case 'held': process.stderr.write('held\n'); return;
    case 'idleSource':
      frame.result = { kind: 'sourceComplete', identity: { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', byteCount: 0 }, fingerprint: { device: '1', inode: '1', size: 0, mode: 33188, modifiedSeconds: '0', modifiedNanoseconds: 0, changedSeconds: '0', changedNanoseconds: 0 }, key: null };
      break;
    case 'wrongId': frame.requestId = 'wrong'; break;
    case 'wrongGeneration': frame.generation = 'wrong'; break;
    case 'wrongVersion': frame.wireVersion = 2; break;
    case 'partial': stdout.write('{"wireVersion":'); process.exit(0); break;
    case 'invalidUTF8': stdout.write(Buffer.from([0xff, 0x0a])); break;
    case 'duplicate': stdout.write(JSON.stringify(frame) + '\n' + JSON.stringify(frame) + '\n'); return;
    case 'emptyClose': process.exit(23); break;
    case 'badSourceReceipt':
      stdout.write(JSON.stringify({ ...frame, kind: 'bytes', result: undefined, bytes: 'YWJj' }) + '\n');
      frame.result = { kind: 'sourceComplete', identity: { sha256: '0'.repeat(64), byteCount: 3 }, fingerprint: { device: '1', inode: '1', size: 3, mode: 33188, modifiedSeconds: '0', modifiedNanoseconds: 0, changedSeconds: '0', changedNanoseconds: 0 }, key: null };
      break;
    default: throw new Error('Missing test scenario');
  }
  stdout.write(JSON.stringify(frame) + '\n');
});
