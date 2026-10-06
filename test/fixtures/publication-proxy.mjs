#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

const child = spawn(process.env.SMIP_NATIVE, [process.argv[2]], { stdio: 'pipe', env: process.env });
let input = '', output = '', publication = null;
process.stdin.on('data', bytes => {
  input += bytes.toString();
  void forward();
});
async function forward() {
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.operation.kind === 'publishManifest') {
      publication = request.requestId;
      if (process.env.SMIP_PUBLICATION === 'refuse') {
        const file = await open(process.env.SMIP_MANIFEST, 'wx');
        await file.writeFile('existing completion marker'); await file.sync(); await file.close();
      }
    }
    child.stdin.write(line + '\n');
  }
}
child.stdout.on('data', bytes => {
  output += bytes.toString();
  let newline;
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    const frame = JSON.parse(line);
    if (frame.requestId === publication && process.env.SMIP_PUBLICATION !== 'refuse') {
      if (frame.result.kind !== 'manifestPublished') throw Error('publication did not complete');
      if (process.env.SMIP_PUBLICATION === 'malformed') process.stdout.write('{malformed acknowledgement}\n');
      child.kill('SIGTERM'); child.once('close', () => process.exit(23));
    } else process.stdout.write(line + '\n');
  }
});
child.stderr.pipe(process.stderr);
process.on('SIGTERM', () => { child.kill('SIGTERM'); child.once('close', () => process.exit(0)); });
process.stdin.on('end', () => child.stdin.end());
