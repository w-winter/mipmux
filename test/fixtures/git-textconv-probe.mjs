import { readFileSync, writeFileSync } from 'node:fs';

const [marker, source] = process.argv.slice(2);
writeFileSync(marker, 'executed');
process.stdout.write(readFileSync(source));
