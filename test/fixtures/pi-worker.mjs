import { createInterface } from 'node:readline';
const reader = createInterface({ input: process.stdin });
reader.once('line', line => {
  const start = JSON.parse(line), scope = { generation: start.generation, job: start.job };
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const terminal = { ...scope, kind: 'complete', outcome: 'complete', code: '' };
  if (['deferred', 'aborted', 'length', 'empty'].includes(process.env.SCENARIO)) {
    const identity = { provider: start.config.provider, model: start.config.model, api: 'synthetic' };
    const completion = { dispatched: identity, reported: identity, serverModel: null, reportedServerModels: null,
      stopReason: process.env.SCENARIO === 'empty' ? 'stop' : process.env.SCENARIO,
      channel: 'ordinary', textBytes: 0, textSHA256: '0'.repeat(64), textOnly: true,
      nonempty: process.env.SCENARIO !== 'empty', diagnostics: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: [] };
    emit({ ...scope, kind: 'evidence', fact: { kind: 'preflight', effective: { identity, thinking: start.config.thinking,
      contextWindow: 8192, maxTokens: 1024, recordSHA256: '0'.repeat(64), modelRecord: {}, endpointSHA256: '0'.repeat(64), headersSHA256: null,
      expectedServerModel: null },
      policy: start.config.policy } });
    for (const kind of ['completion', 'assistant']) emit({ ...scope, kind: 'evidence', fact: { kind, value: completion } });
    emit({ ...scope, kind: 'evidence', fact: { kind: 'prompt', outcome: 'resolved' } });
    for (const stage of ['accepted', 'settled', 'idle', 'observationsSettled', 'disposed']) {
      emit({ ...scope, kind: 'evidence', fact: { kind: 'lifecycle', stage } });
    }
  }
  if (process.env.SCENARIO === 'wrongGeneration') {
    emit({ ...scope, generation: 'retired', kind: 'tool', id: 'one', call: { name: 'draft_inspect', input: { view: 'metadata', continuation: null, maxOutputBytes: 10000 } } });
  } else if (process.env.SCENARIO === 'outstandingTool') {
    emit({ ...scope, kind: 'tool', id: 'one', call: { name: 'draft_inspect', input: { view: 'metadata', continuation: null, maxOutputBytes: 10000 } } });
    emit(terminal);
  } else {
    emit(terminal);
    if (process.env.SCENARIO === 'duplicate') emit(terminal);
  }
  process.stdin.destroy();
});
