import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2];
if (destination !== 'dist' && destination !== 'dist-test/src') throw new Error('Expected dist or dist-test/src');
const out = join(root, destination);
await mkdir(join(out, 'prompts'), { recursive: true });
await copyFile(join(root, 'prompts/discovery-v1.md'), join(out, 'prompts/discovery-v1.md'));
await writeFile(join(out, 'dependency-identity.json'), JSON.stringify({
  buildLockSHA256: createHash('sha256').update(await readFile(join(root, 'package-lock.json'))).digest('hex'),
}) + '\n');
