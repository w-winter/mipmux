import { spawn } from 'node:child_process';

const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'pipe', env: process.env });
let input = '', scope;
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.kind === 'start') scope = { job: message.job, generation: message.generation };
    child.stdin.write(line + '\n');
  }
});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
process.on('SIGUSR1', () => {
  process.stdout.write('{}\n' + JSON.stringify({ ...scope, kind: 'evidence', fact: { kind: 'lifecycle', stage: 'accepted' } }) + '\n');
});
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
child.once('close', code => process.exit(code ?? 1));
