import { spawn } from 'node:child_process';

const child = spawn(process.env.SMIP_RG, process.argv.slice(2), { stdio: 'pipe', env: process.env });
child.stdin.end();
child.stdout.resume();
child.stderr.pipe(process.stderr);
child.once('close', () => process.stderr.write('SMIP_SEARCH_HELD\n'));
process.on('SIGTERM', () => {
  if (child.exitCode !== null) process.exit(0);
  child.kill('SIGTERM');
  child.once('close', () => process.exit(0));
});
setInterval(() => {}, 1000);
