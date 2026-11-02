import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'mipmux-dockerignore-'));
const tag = 'mipmux-dockerignore-probe:' + process.pid;
try {
  await copyFile(resolve('.dockerignore'), join(directory, '.dockerignore'));
  await mkdir(join(directory, 'nested/deeper'), { recursive: true });
  for (const path of ['.env', '.env.local', 'nested/.env', 'nested/.env.test', 'nested/deeper/.env.production']) {
    await writeFile(join(directory, path), 'synthetic-environment-sentinel');
  }
  for (const path of ['public.txt', 'nested/public.txt', 'nested/deeper/public.txt']) {
    await writeFile(join(directory, path), 'ordinary-neighbor');
  }
  await writeFile(join(directory, 'Dockerfile'), 'FROM node:22.23.4-bookworm-slim\nCOPY . /probe\n');
  execFileSync('docker', ['build', '--quiet', '--tag', tag, directory], { stdio: ['ignore', 'pipe', 'inherit'] });
  const output = execFileSync('docker', ['run', '--rm', tag, 'node', '-e',
    'const fs=require("node:fs"); console.log(JSON.stringify(fs.readdirSync("/probe",{recursive:true}).sort()))'], { encoding: 'utf8' });
  const paths = JSON.parse(output);
  console.log(JSON.stringify({ image: execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim(), paths }));
  assert(!paths.some(path => path.split('/').some(part => part === '.env' || part.startsWith('.env.'))));
  for (const path of ['public.txt', 'nested/public.txt', 'nested/deeper/public.txt']) assert(paths.includes(path));
} finally {
  execFileSync('docker', ['image', 'rm', tag], { stdio: 'ignore' });
  execFileSync('trash', [directory]);
}
