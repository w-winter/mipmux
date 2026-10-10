import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { renderInitialTree } from '../src/context/initial-tree.js';
import { SmipRuntime } from '../src/index.js';
import type { InventoryEntry } from '../src/contracts/inventory.js';
import { structuralFile, structuralRoots } from './fixtures/structural-inventory.js';

test('initial tree uses explicit implementation stars, delivered codemap pluses and excludes skipped entries', () => {
  const entries: InventoryEntry[] = [
    { kind: 'directory', root: 'r', path: 'folder' },
    structuralFile('r', 'folder/Selected.swift', ['Selected'], []),
    structuralFile('r', 'Map.swift', ['Map'], []), structuralFile('r', 'Ready.swift', ['Ready'], []),
    { kind: 'acquisitionFailed', root: 'r', path: 'Unreadable.swift', code: 'permissionDenied' },
    { kind: 'skipped', root: 'r', path: 'hidden.swift', reason: 'policy' },
  ];
  const text = renderInitialTree({ roots: structuralRoots('r', 's'), entries }, [
    { kind: 'full', source: { root: 'r', path: 'folder/Selected.swift' } },
    { kind: 'codemap', source: { root: 'r', path: 'Map.swift' } },
  ]);
  // Line bytes determine the adaptive view's budget, not just its appearance.
  assert.equal(text, 'r\n├── folder\n│   └── Selected.swift *\n├── Map.swift +\n├── Ready.swift\n└── Unreadable.swift\n\n\ns\n' +
    '\n\n(* denotes selected files)\n(+ denotes a delivered codemap)');
});

test('the RP byte boundary chooses full versus directory-only views without hiding selected implementation', () => {
  for (const count of [87, 88]) {
    const files = Array.from({ length: count }, (_, index) => structuralFile('r', 'a'.repeat(240) + String(index).padStart(3, '0') + '.swift', [], []));
    const text = renderInitialTree({ roots: structuralRoots('r'), entries: files }, [{ kind: 'full', source: files[0]! }]);
    assert(text.includes(files[0]!.path + ' *'));
    if (count === 87) {
      for (const file of files) assert(text.includes(file.path));
      assert(!text.includes('Config:'));
    } else {
      assert(!text.includes(files[1]!.path));
      assert(text.includes('Config: directory-only view; selected files shown.'));
    }
  }
});

test('depth reduction retains selected descendants but does not promote codemaps into selected paths', () => {
  const folder = 'd1/d2/d3/d4';
  const directories: InventoryEntry[] = ['d1', 'd1/d2', 'd1/d2/d3', folder, folder + '/d5'].map(path => ({ kind: 'directory', root: 'r', path }));
  const files = Array.from({ length: 90 }, (_, index) => structuralFile('r', folder + '/' + 'a'.repeat(240) + index + '.swift', [], []));
  const selected = structuralFile('r', folder + '/d5/Selected.swift', [], []), codemap = structuralFile('r', folder + '/Map.swift', [], []);
  const text = renderInitialTree({ roots: structuralRoots('r'), entries: [...directories, ...files, selected, codemap] }, [
    { kind: 'full', source: selected }, { kind: 'codemap', source: codemap },
  ]);
  assert(text.includes('Selected.swift *')); assert(!text.includes('Map.swift'));
  assert(text.includes('...')); assert(text.includes('Config: depth cap 3.'));
});

test('sibling presentation caps preserve the RP grouping and roots remain when every detailed view exceeds budget', () => {
  const files = Array.from({ length: 101 }, (_, index) => structuralFile('r', `f${String(index).padStart(3, '0')}.swift`, [], []));
  const text = renderInitialTree({ roots: structuralRoots('r'), entries: files }, [{ kind: 'full', source: files[100]! }]);
  assert(text.includes('f100.swift *')); assert(!text.includes('f099.swift'));
  const large = Array.from({ length: 100 }, (_, index) => structuralFile('r', 'a'.repeat(240) + index + '.swift', [], []));
  assert.equal(renderInitialTree({ roots: structuralRoots('r', 's'), entries: large },
    large.map(source => ({ kind: 'full', source }))), 'r\ns');
});

test('directory-depth and selected-only attempts follow broad views when those exceed the RP budget', () => {
  const selected = structuralFile('r', 'Selected.swift', [], []);
  const selection = [{ kind: 'full' as const, source: selected }];
  const rootFiles = Array.from({ length: 90 }, (_, index) => structuralFile('r', 'a'.repeat(240) + index + '.swift', [], []));
  const nested: InventoryEntry[] = ['d1', 'd1/d2', 'd1/d2/d3', 'd1/d2/d3/d4'].map(path => ({ kind: 'directory', root: 'r', path }));
  for (let index = 0; index < 100; index++) nested.push({ kind: 'directory', root: 'r', path: 'd1/d2/d3/d4/' + 'a'.repeat(240) + index });
  const depth = renderInitialTree({ roots: structuralRoots('r'), entries: [...rootFiles, ...nested, selected] }, selection);
  assert(depth.includes('Selected.swift *'));
  assert(depth.includes('Config: directory-only view; depth cap 3; selected files shown.'));
  const folders: InventoryEntry[] = Array.from({ length: 100 }, (_, index) => ({ kind: 'directory', root: 'r', path: 'a'.repeat(240) + index }));
  const onlySelected = renderInitialTree({ roots: structuralRoots('r'), entries: [...folders, selected] }, selection);
  assert(onlySelected.includes('Selected.swift *'));
  assert(!onlySelected.includes('a'.repeat(240)));
  assert(onlySelected.includes('Config: selected-only view.'));
});

test('initial context supplies all roots, explicit inputs and budget facts without embedding document bodies', async () => {
  await mkdir('test-output', { recursive: true });
  const directory = await mkdtemp(resolve('test-output/initial-context-'));
  for (const name of ['r', 's', 'out']) await mkdir(join(directory, name));
  await writeFile(join(directory, 'r/notes.txt'), 'REQUIRED_DOCUMENT_BODY_NOT_STARTUP_METADATA');
  await writeFile(join(directory, 's/other.txt'), 'Other source');
  const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), credentialPaths: [], contextBudgetUnits: 200000,
    terminationGraceMs: 100, nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {} });
  try {
    const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: join(directory, 'r') },
      { name: 's', absolutePath: join(directory, 's') }], outputRoot: join(directory, 'out'), exclusions: [] }, new AbortController().signal);
    const draft = await workspace.createDraft({ task: 'Inspect', constraints: '', purpose: 'investigation', requiredSources: [],
      documents: [{ kind: 'localDocument', id: 'notes', role: 'evidence', source: { root: 'r', path: 'notes.txt' } }],
      patches: [], discoveryHints: [], outputName: 'packet',
      allowance: { kind: 'net', units: 100000, method: 'utf8-21-over-80-v1', overheadReserved: true } }, new AbortController().signal);
    const text = draft.initialContext();
    const block = text.match(/^(`{3,})\n([\s\S]*?)\n\1\n/m); assert(block);
    const metadata: unknown = JSON.parse(block[2]!);
    assert(Compile(Type.Object({ revision: Type.Literal(0), codemapMode: Type.Literal('automatic'),
      contextBudgetUnits: Type.Literal(200000), accountingMethod: Type.Literal('utf8-21-over-80-v1'),
      roots: Type.Array(Type.Object({ name: Type.String() }), { minItems: 2, maxItems: 2 }),
      explicitSources: Type.Array(Type.Unknown(), { maxItems: 0 }), inferredCodemaps: Type.Object({ count: Type.Literal(0), itemUnits: Type.Literal(0) }),
      measurement: Type.Object({ allowance: Type.Literal(100000), complete: Type.Literal(false) }),
      documents: Type.Array(Type.Object({ id: Type.Literal('document:notes') }), { minItems: 1, maxItems: 1 }),
    })).Check(metadata));
    assert(text.includes('notes.txt')); assert(text.includes('other.txt'));
    assert(!text.includes('notes.txt *')); assert(!text.includes('REQUIRED_DOCUMENT_BODY_NOT_STARTUP_METADATA'));
    await writeFile(join(directory, 'initial-context-proof.txt'), text);
  } finally { await runtime.close(); }
});
