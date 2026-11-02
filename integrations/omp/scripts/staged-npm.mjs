// Runs `npm <arguments> <folder>` on the package as npm should publish it, staged in a temporary folder: fresh copies of
// the shared modules, this package's own files, and package.json without "private" and the development scripts.
// "private": true keeps a plain `npm publish` here from shipping stale copies, since ignore-scripts=true (set in this
// folder's .npmrc) stops npm running a prepack script. `npm run release` publishes through this script.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmArguments = process.argv.slice(2);
if (!npmArguments.length) throw new Error('Name the npm command to run on the staged package, such as publish or pack.');

execFileSync(process.execPath, [join(packageRoot, 'scripts/copy-shared.mjs')], { stdio: 'inherit' });
const staging = await mkdtemp(join(tmpdir(), 'omp-mipmux-stage-'));
let status = 1;
try {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  delete manifest.private;
  delete manifest.scripts;
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const entry of ['README.md', 'LICENSE', 'src']) await cp(join(packageRoot, entry), join(staging, entry), { recursive: true });
  status = spawnSync('npm', [...npmArguments, staging], { cwd: packageRoot, stdio: 'inherit' }).status ?? 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
process.exitCode = status;
