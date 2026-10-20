import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import type { DiscoveryInput } from '../src/discovery/runner.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { scriptedProvider } from './fixtures/scripted-provider.js';

const input: DiscoveryInput = { tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', roots: ['r'], hints: [] };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('one runner snapshots configured prompt bytes per job and sees edits on the next job', async () => {
  let release!: () => void, entered!: () => void;
  const boundary = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const provider = await scriptedProvider((_summary, index) => index === 1
    ? { kind: 'tool', name: 'draft_validate', input: { maxOutputBytes: 3000 }, stop: 'tool_use', tokens: 10 }
    : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 });
  provider.config.policy.compaction.enabled = false;
  const promptPath = join(provider.directory, 'editable.md');
  const template = await readFile('test/fixtures/discovery-template.md', 'utf8');
  const first = Buffer.from(template.replace('BODY_LITERAL', 'FIRST_PROMPT_INSTRUCTION'));
  const second = Buffer.from(template.replace('BODY_LITERAL', 'SECOND_PROMPT_INSTRUCTION'));
  await writeFile(promptPath, first);
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  try {
    const config = { ...provider.config, promptTemplatePath: promptPath };
    const runner = new PiRunner(config, supervisor, nativeDiscoveryRenderer(supervisor));
    const running = runner.run(input, { call: async () => { entered(); await released; return { kind: 'ok' }; } }, new AbortController().signal, () => {});
    await boundary; await writeFile(promptPath, second); release();
    const one = await running;
    const two = await runner.run(input, { call: async () => { throw Error('Unexpected tool'); } }, new AbortController().signal, () => {});
    assert.equal(one.kind, 'complete'); assert.equal(two.kind, 'complete');
    assert.equal(one.receipt.template.identity.sha256, digest(first)); assert.equal(two.receipt.template.identity.sha256, digest(second));
    const firstPolicy = Buffer.from('L|FIRST_PROMPT_INSTRUCTION|FIRST_PROMPT_INSTRUCTION|R');
    const secondPolicy = Buffer.from('L|SECOND_PROMPT_INSTRUCTION|SECOND_PROMPT_INSTRUCTION|R');
    assert.deepEqual(one.receipt.policyIdentity, { sha256: digest(firstPolicy), byteCount: firstPolicy.length });
    assert.deepEqual(two.receipt.policyIdentity, { sha256: digest(secondPolicy), byteCount: secondPolicy.length });
    assert(provider.requests.length === 3);
    for (const request of provider.requests.slice(0, 2)) {
      assert(JSON.stringify(request.system).includes('FIRST_PROMPT_INSTRUCTION'));
      assert(!JSON.stringify(request.system).includes('SECOND_PROMPT_INSTRUCTION'));
    }
    assert(JSON.stringify(provider.requests[2]!.system).includes('SECOND_PROMPT_INSTRUCTION'));
    await writeFile(join(provider.directory, 'prompt-snapshots.json'), JSON.stringify({ one, two, requests: provider.requests }, null, 2));
  } finally { release(); await supervisor.close(); await provider.close(); }
});

test('prompt admission rejects invalid files before spawn and closes descriptors on read cancellation', async t => {
  const provider = await scriptedProvider(() => { throw Error('No model expected'); });
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const promptPath = join(provider.directory, 'input.md');
  const spawn = supervisor.spawn.bind(supervisor);
  let workerSpawns = 0;
  t.mock.method(supervisor, 'spawn', (spec: Parameters<typeof spawn>[0]) => {
    if (spec.args.some(arg => arg.endsWith('/pi-worker.js'))) { workerSpawns++; throw Error('Unexpected Pi spawn'); }
    return spawn(spec);
  });
  try {
    const relative = { ...provider.config, promptTemplatePath: 'relative.md' };
    assert.throws(() => new PiRunner(relative, supervisor, nativeDiscoveryRenderer(supervisor)), /invalidDiscoveryConfiguration/);
    for (const [scenario, code] of [['missing', 'discoveryTemplateReadFailed'], ['version', 'invalidDiscoveryTemplate'],
      ['utf8', 'invalidDiscoveryTemplate'], ['directory', 'nonRegularDiscoveryTemplate'], ['fifo', 'nonRegularDiscoveryTemplate']] as const) {
      const path = join(provider.directory, scenario);
      // compat-ok: This test checks that an unsupported header never reaches a provider
      if (scenario === 'version') await writeFile(path, '# mipmux discovery template v2\n');
      // compat-ok: This test checks that invalid UTF-8 never reaches a provider
      if (scenario === 'utf8') await writeFile(path, Buffer.concat([Buffer.from('# mipmux discovery template v1\n'), Buffer.from([0xff])]));
      if (scenario === 'fifo') execFileSync('mkfifo', [path]);
      const selected = scenario === 'directory' ? provider.directory : path;
      const config = { ...provider.config, promptTemplatePath: selected };
      if (scenario === 'fifo') {
        const program = `import {PiRunner} from ${JSON.stringify(new URL('../src/discovery/pi-runner.js', import.meta.url).href)};
          import {ProcessSupervisor} from ${JSON.stringify(new URL('../src/runtime/process-supervisor.js', import.meta.url).href)};
          import {nativeDiscoveryRenderer} from ${JSON.stringify(new URL('./fixtures/render-discovery-prompt.js', import.meta.url).href)};
          const supervisor = new ProcessSupervisor({terminationGraceMs:0});
          supervisor.spawn = () => {throw Error('unexpectedSpawn')};
          try {await new PiRunner(${JSON.stringify(config)},supervisor,nativeDiscoveryRenderer(supervisor)).run(${JSON.stringify(input)},
            {call:async()=>{throw Error('unexpectedTool')}},new AbortController().signal,()=>{}); process.exitCode=1;}
          catch(error){console.log(error.code ?? error.message)} finally {await supervisor.close()}`;
        const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program], { timeout: 3000 });
        assert.equal(result.stdout.trim(), 'nonRegularDiscoveryTemplate');
        continue;
      }
      await assert.rejects(new PiRunner(config, supervisor, nativeDiscoveryRenderer(supervisor)).run(input,
        { call: async () => { throw Error('Unexpected tool'); } }, new AbortController().signal, () => {}),
      { code });
    }
    const validTemplate = await readFile('test/fixtures/discovery-template.md', 'utf8');
    await writeFile(promptPath, validTemplate);
    const originalOpen = fsPromises.open;
    let closed = 0, acquired = 0;
    const abort = new AbortController();
    const hook = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args); acquired++;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed++; };
      handle.readFile = async options => {
        assert(options && options instanceof Object);
        assert.equal(options.signal, abort.signal);
        abort.abort(); throw abort.signal.reason;
      };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const config = { ...provider.config, promptTemplatePath: promptPath };
      await assert.rejects(new PiRunner(config, supervisor, nativeDiscoveryRenderer(supervisor)).run(input,
        { call: async () => { throw Error('Unexpected tool'); } }, abort.signal, () => {}), { name: 'AbortError' });
      assert.equal(acquired, 1); assert.equal(closed, acquired);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(provider.requests.length, 0);
    assert.equal(workerSpawns, 0);
    assert.equal((await readFile(promptPath, 'utf8')), validTemplate);
  } finally { await supervisor.close(); await provider.close(); }
});
