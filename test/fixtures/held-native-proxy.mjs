#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn(process.env.SMIP_NATIVE, process.argv.slice(2), { stdio: 'pipe', env: process.env });
let input = '', output = '';
const held = new Set();
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.operation.kind === 'readSource' && request.operation.path === 'file.txt') held.add(request.requestId);
    child.stdin.write(line + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', bytes => {
  output += bytes.toString();
  let newline;
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    const frame = JSON.parse(line);
    if (held.has(frame.requestId)) {
      if (frame.result?.kind === 'sourceComplete') process.stderr.write('SMIP_READ_HELD\n');
    }
    else process.stdout.write(line + '\n');
  }
});
child.stderr.pipe(process.stderr);
process.on('SIGTERM', () => { child.kill('SIGTERM'); child.once('close', () => process.exit(0)); });
child.once('close', code => process.exit(code ?? 1));
