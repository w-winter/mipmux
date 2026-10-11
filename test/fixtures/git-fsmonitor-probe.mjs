import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'executed\n');
process.stdout.write('fixture-token\0\0');
