import { nativeDiscoveryRenderer } from './fixtures/render-discovery-prompt.js';
import { copyContext } from './fixtures/copy-context.js';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scriptedProvider } from './fixtures/scripted-provider.js';
import { PiRunner } from '../src/discovery/pi-runner.js';
import { ProcessSupervisor } from '../src/runtime/process-supervisor.js';
import type { DiscoveryCall } from '../src/contracts/discovery.js';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { toolJSON } from './fixtures/tool-json.js';

const record = Compile(Type.Record(Type.String(), Type.Unknown()));
const declaration = Compile(Type.Object({ kind: Type.Literal('workspace'), id: Type.String() }));
type ToolArguments = NonNullable<Parameters<Client['callTool']>[0]['arguments']>;

test('concise MCP exploration matches explicit options and preserves validation, caps and selection authority', async () => {
  await mkdir('test-output', { recursive: true });
  const base = await mkdtemp(join(tmpdir(), 'mipmux-concise-inputs-'));
  const root = join(base, 'root'), out = join(base, 'out');
  await mkdir(root); await mkdir(out);
  await writeFile(join(root, 'greet.ts'), 'export function greet(name: string) { return `Hello ${name}`; }\n');
  const config = join(base, 'config.json');
  await writeFile(config, JSON.stringify({ copyContext: copyContext(), cachePath: join(base, 'cache'),
    nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/MipmuxBridge`), nativeEnvironment: {},
    terminationGraceMs: 100, contextBudgetUnits: 1000000, credentialPaths: [],
    git: null, discovery: null, defaultMaxOutputBytes: 12000 }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli/main.js'), 'mcp', '--config', config], cwd: '/', stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'concise-inputs', version: '1' });
  try {
    await client.connect(transport);
    const declared = await client.callTool({ name: 'workspace_declare', arguments: { spec: { roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: out } } });
    const value = declaration.Parse(toolJSON(declared));
    const workspaceId = value.id;
    const call = (name: string, args: ToolArguments) => client.callTool({ name, arguments: { workspaceId, ...args } });
    const filters = { roots: [], paths: [], exclude: [], extensions: [] };
    const pairs: [string, ToolArguments, ToolArguments][] = [
      ['get_file_tree', {}, { input: { type: 'files', mode: 'auto', scope: null, maxDepth: null, continuation: null }, draftId: null }],
      ['read_file', { input: { root: 'r', path: 'greet.ts' } }, { input: { root: 'r', path: 'greet.ts', start_line: null, offset: null, limit: null, continuation: null } }],
      ['get_code_structure', { input: { seeds: [{ root: 'r', path: 'greet.ts', kind: 'file' }] } }, { input: { seeds: [{ root: 'r', path: 'greet.ts', kind: 'file' }], expand: 'none', depth: 1, signatures: true, size: 'medium' } }],
      ['file_search', { input: { query: { text: 'GREET' } } }, { input: { query: { kind: 'auto', text: 'GREET', caseSensitive: false, wholeWord: false }, mode: 'auto', filters, before: 0, after: 0, countOnly: false, maxResults: 50, continuation: null } }],
      ['file_search', { input: { query: { kind: 'glob', text: '*.ts' } } }, { input: { query: { kind: 'glob', text: '*.ts', caseSensitive: false }, mode: 'path', filters, before: 0, after: 0, countOnly: false, maxResults: 50, continuation: null } }],
    ];
    const results = [];
    for (const [name, concise, explicit] of pairs) {
      const result = await call(name, concise);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.deepEqual(result, await call(name, explicit));
      results.push({ name, concise, explicit, result });
    }
    const regex = await call('file_search', { input: { query: { kind: 'regex', text: '^export', caseSensitive: true }, filters: { extensions: ['.ts'] }, after: 1 } });
    assert.equal(regex.isError, false, JSON.stringify(regex));
    assert.equal(record.Parse(toolJSON(regex)).returnedMatchingLines, 1);
    const whitespace = await call('file_search', { input: { query: { text: ' greet ' } } });
    assert.equal(record.Parse(toolJSON(whitespace)).returnedMatchingLines, 1);
    const cap = await call('read_file', { input: { root: 'r', path: 'greet.ts' }, maxOutputBytes: 1 });
    assert.equal(record.Parse(toolJSON(cap)).kind, 'outputBudgetTooSmall');
    for (const [name, args] of [
      ['get_file_tree', { input: { type: 'files', mode: 'selected' } }],
      ['get_file_tree', { input: { type: 'files', mode: 'selected' }, draftId: 'foreign' }],
      ['read_file', { input: { path: 'greet.ts' } }],
      ['get_code_structure', { input: { seeds: [], depth: 0 } }],
      ['file_search', { input: { query: { kind: 'glob', text: '*.ts' }, mode: 'content' } }],
      ['get_file_tree', { input: { bogus: 1 } }],
      ['file_search', { input: { query: { text: 'x' }, filters: { bogus: [] } } }],
    ] as const) {
      const result = await call(name, args).catch(error => {
        assert(error instanceof ProtocolError); assert.equal(error.code, ProtocolErrorCode.InvalidParams); return null;
      });
      assert(result === null || result.isError);
      if (result !== null) assert(!JSON.stringify(result).includes('operationFailed'), JSON.stringify(result));
    }
    await writeFile(join(base, 'concise-receipt.json'), JSON.stringify(results, null, 2));
  } finally { await client.close(); }
});

test('scout exploration normalizes concise inputs before crossing parent IPC', async () => {
  const requests = [
    { name: 'get_file_tree', input: { maxOutputBytes: 3000 } },
    { name: 'read_file', input: { root: 'r', path: 'file.txt', maxOutputBytes: 3000 } },
    { name: 'get_code_structure', input: { seeds: [{ root: 'r', path: 'file.txt', kind: 'file' }], maxOutputBytes: 3000 } },
    { name: 'file_search', input: { query: { text: 'needle' }, maxOutputBytes: 3000 } },
    { name: 'file_search', input: { query: { kind: 'glob', text: '*.txt' }, maxOutputBytes: 3000 } },
  ];
  const provider = await scriptedProvider((_summary, index) => {
    const request = requests[index - 1];
    return request ? { kind: 'tool', ...request, stop: 'tool_use', tokens: 10 }
      : { kind: 'text', text: 'Complete', stop: 'end_turn', tokens: 10 };
  });
  provider.config.policy.compaction.enabled = false;
  const supervisor = new ProcessSupervisor({ terminationGraceMs: 100 });
  const calls: DiscoveryCall[] = [];
  try {
    const result = await new PiRunner(provider.config, supervisor, nativeDiscoveryRenderer(supervisor)).run({ tokenBudget: 10000, enhancementMode: 'fullRewrite' as const, task: 'Inspect', purpose: 'investigation', initialContext: 'Fixture context', fileTree: '', currentPrompt: 'Fixture message', restrictsReviewGitToExplicitReadOnly: true, constraints: '', roots: ['r'], hints: [] },
      { call: async call => { calls.push(call); return { kind: 'observed' }; } }, new AbortController().signal, () => {});
    assert.equal(result.kind, 'complete'); assert.equal(calls.length, requests.length);
    assert.deepEqual(calls[0], { name: 'get_file_tree', input: { type: 'files', mode: 'auto', scope: null, maxDepth: null, continuation: null, maxOutputBytes: 3000 } });
    assert(calls[1]?.name === 'read_file'); assert.deepEqual(calls[1].input['start_line'], null);
    assert(calls[2]?.name === 'get_code_structure'); assert.equal(calls[2].input.depth, 1); assert.equal(calls[2].input.expand, 'none');
    assert(calls[3]?.name === 'file_search'); assert.deepEqual(calls[3].input.query, { kind: 'auto', text: 'needle', caseSensitive: false, wholeWord: false });
    assert(calls[4]?.name === 'file_search'); assert.equal(calls[4].input.mode, 'path');
    await writeFile(join(provider.directory, 'scout-inputs.json'), JSON.stringify(calls, null, 2));
  } finally { await supervisor.close(); await provider.close(); }
});
