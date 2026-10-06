import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import { runRipgrep } from '../src/exploration/ripgrep.js';

test('search never accepts truncated or missing terminal statistics as complete counts', async () => {
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const match = { type: 'match', data: { path: { text: './0' }, lines: { text: 'needle\n' }, line_number: 1, absolute_offset: 0,
    submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }] } };
  const conflicting = { type: 'summary', data: { stats: { matches: 2, matched_lines: 2 } } };
  try {
    for (const output of ['', '{\n', JSON.stringify(match) + '\n', JSON.stringify(match) + '\n' + JSON.stringify(conflicting) + '\n']) {
      await assert.rejects(runRipgrep(supervisor, process.execPath, ['-e', `process.stdout.write(${JSON.stringify(output)})`], '/', '',
        new AbortController().signal, () => {}), /searchProtocolError/);
    }
  } finally { await supervisor.close(); }
});
