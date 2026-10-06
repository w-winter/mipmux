import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';

test('owned cancellation joins close and leaves another owner running', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 20 });
  const first = supervisor.spawn({ executable: process.execPath, args: ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)'], env: {}, cwd: '/' });
  const second = supervisor.spawn({ executable: process.execPath, args: ['-e', 'process.stdin.resume()'], env: {}, cwd: '/' });
  await new Promise<void>(resolve => first.child.stdout.once('data', () => resolve()));
  await first.stop();
  const receipt = await first.closed;
  assert.equal(receipt.signal, 'SIGKILL');
  assert.equal(second.child.exitCode, null);
  second.child.stdin.end();
  assert.equal((await second.closed).code, 0);
  await supervisor.close();
  assert.throws(() => supervisor.spawn({ executable: process.execPath, args: [], env: {}, cwd: '/' }), /closed/);
});
