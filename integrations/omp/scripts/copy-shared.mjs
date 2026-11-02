// Copies pi-mipmux's host-independent modules into src/, where extension.ts and routes.ts are this package's own.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFolder = join(packageRoot, '../pi/src'), targetFolder = join(packageRoot, 'src');
const shared = ['config.ts', 'draft.ts', 'ignore-file.ts', 'panel.ts', 'paths.ts', 'register.ts', 'report.ts', 'screens.ts',
  'server-config.ts', 'state.ts', 'store.ts'];
// omp serves its own packages under Pi's names, but type checks need omp's names. It also replaces a bare `typebox` import
// with its own schema builder, which typebox/compile cannot check, so the copies reach TypeBox through the `#typebox` alias.
const renamed = new Map([
  ['@earendil-works/pi-coding-agent', '@oh-my-pi/pi-coding-agent'],
  ['@earendil-works/pi-tui', '@oh-my-pi/pi-tui'],
  ['typebox', '#typebox'],
]);

for (const file of shared) {
  const original = await readFile(join(sourceFolder, file), 'utf8');
  const copy = original.replace(/from '([^']+)'/g, (statement, specifier) => {
    const target = renamed.get(specifier);
    return target === undefined ? statement : `from '${target}'`;
  });
  const unmapped = /from '@earendil-works\/[^']+'/.exec(copy);
  if (unmapped !== null) throw new Error(`${file} has ${unmapped[0]}, which scripts/copy-shared.mjs does not rename`);
  await writeFile(join(targetFolder, file), `// Copied from integrations/pi/src/${file} by scripts/copy-shared.mjs; edit the original.\n${copy}`);
}
