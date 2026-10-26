#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn(process.env.MIPMUX_NATIVE, process.argv.slice(2), { stdio: 'pipe', env: process.env });
const operation = process.env.MIPMUX_HELD_OPERATION;
const terminal = { readSource: 'sourceComplete', scanSearchSources: 'searchSourceScan' }[operation];
if (!terminal) throw new Error('Missing held native operation');
let input = '', output = '';
const held = new Set();
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.operation.kind === operation && (operation === 'readSource'
      ? request.operation.path === 'file.txt' : request.operation.pattern === process.env.MIPMUX_HELD_PATTERN)) held.add(request.requestId);
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
      if (frame.result?.kind === terminal) {
        process.stderr.write(operation === 'readSource' ? 'MIPMUX_READ_HELD\n' : 'MIPMUX_SEARCH_HELD\n');
      }
    }
    else process.stdout.write(line + '\n');
  }
});
child.stderr.pipe(process.stderr);
process.on('SIGTERM', () => { child.kill('SIGTERM'); child.once('close', () => process.exit(0)); });
child.once('close', code => process.exit(code ?? 1));
