#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';

const child = spawn(process.env.MIPMUX_NATIVE, process.argv.slice(2), { stdio: 'pipe', env: process.env });
const boundary = process.env.MIPMUX_SCOPE_BOUNDARY;
if (!['catalog', 'body'].includes(boundary)) throw new Error('Missing scope boundary');
let input = '', held = false, querying = false, watcher;
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.operation.kind === 'refreshSearchScope') querying = true;
    const target = boundary === 'catalog' ? request.operation.kind === 'listDirectory'
      : querying && request.operation.kind === 'readSource' && request.operation.path === 'victim.ts';
    if (!held && target && existsSync(process.env.MIPMUX_SCOPE_ARM)) {
      held = true;
      watcher = watch(dirname(process.env.MIPMUX_SCOPE_RELEASE), () => {
        if (existsSync(process.env.MIPMUX_SCOPE_RELEASE)) {
          watcher.close(); child.stdin.write(line + '\n');
        }
      });
      process.stderr.write('MIPMUX_SCOPE_FRESHNESS_HELD\n');
    } else child.stdin.write(line + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
process.on('SIGTERM', () => {
  watcher?.close(); child.kill('SIGTERM'); child.once('close', () => process.exit(0));
});
child.once('close', code => process.exit(code ?? 1));
