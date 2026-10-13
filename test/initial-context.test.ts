import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { SmipRuntime } from '../src/index.js';

test('initial context supplies all roots, explicit inputs and budget facts without embedding document bodies', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'smip-initial-context-'));
  for (const name of ['r', 's', 'out']) await mkdir(join(directory, name));
  await writeFile(join(directory, 'r/notes.txt'), 'REQUIRED_DOCUMENT_BODY_NOT_STARTUP_METADATA');
  await writeFile(join(directory, 's/other.txt'), 'Other source');
  await writeFile(join(directory, 's/Ready.swift'), 'struct Ready { let value: Int }');
  const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), credentialPaths: [], contextBudgetUnits: 200000,
    terminationGraceMs: 100, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'r') },
      { name: 's', absolutePath: join(directory, 's') }], outputRoot: join(directory, 'out'), exclusions: [] }, new AbortController().signal);
    const draft = await workspace.createDraft({ task: 'Inspect', initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: '', enhancementMode: 'augment' as const, purpose: 'investigation', requiredSources: [],
      documents: [{ kind: 'localDocument', id: 'notes', role: 'evidence', source: { root: 'r', path: 'notes.txt' } }],
      patches: [], discoveryHints: [], outputName: 'packet',
      budgetUnits: 100000 }, new AbortController().signal);
    const text = await draft.initialContext(new AbortController().signal);
    const block = text.match(/^(`{3,})\n([\s\S]*?)\n\1\n/m); assert(block);
    const metadata: unknown = JSON.parse(block[2]!);
    assert(Compile(Type.Object({ revision: Type.Literal(0), codemapMode: Type.Literal('automatic'),
      contextBudgetUnits: Type.Literal(200000), accountingMethod: Type.Literal('utf8-21-over-80-v1'),
      roots: Type.Array(Type.Object({ name: Type.String() }), { minItems: 2, maxItems: 2 }),
      explicitSources: Type.Array(Type.Unknown(), { maxItems: 0 }), inferredCodemaps: Type.Object({ count: Type.Literal(0), itemUnits: Type.Literal(0) }),
      measurement: Type.Object({ allowance: Type.Literal(100000), complete: Type.Literal(true) }),
      documents: Type.Array(Type.Object({ id: Type.Literal('document:notes') }), { minItems: 1, maxItems: 1 }),
    })).Check(metadata));
    assert(text.includes('notes.txt')); assert(text.includes('other.txt'));
    assert(text.includes('Ready.swift +'));
    assert(text.includes('(+ denotes code-map available)'));
    assert(!text.includes('notes.txt *')); assert(!text.includes('REQUIRED_DOCUMENT_BODY_NOT_STARTUP_METADATA'));
    await writeFile(join(directory, 'initial-context-proof.txt'), text);
  } finally { await runtime.close(); }
});
