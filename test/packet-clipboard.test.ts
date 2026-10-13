import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';
import { identity } from '../src/context/material-store.js';

for (const enhancementMode of ['preserve', 'augment', 'fullRewrite'] as const) {
  test(`published ${enhancementMode} packet uses source clipboard sections and complete required evidence`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smip-clipboard-packet-'));
    const root = join(directory, 'root'), output = join(directory, 'out');
    await mkdir(root); await mkdir(output); await mkdir('test-output', { recursive: true });
    const full = 'struct Main { let peer: Peer }\r\n';
    const sliced = 'outside\r\nselected 🙂\r\nend\n';
    await writeFile(join(root, 'Main.swift'), full);
    await writeFile(join(root, 'Peer.swift'), 'struct Peer { let value: Int }\n');
    await writeFile(join(root, 'slice.txt'), sliced);
    const runtime = new SmipRuntime({ cachePath: join(directory, 'cache'), contextBudgetUnits: 200000,
      credentialPaths: [], nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`),
      nativeEnvironment: {}, terminationGraceMs: 100 });
    const signal = new AbortController().signal;
    try {
      const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: output }, signal);
      const draft = await workspace.createDraft({ task: 'Original user prompt\nλ', duplicateUserInstructionsAtTop: false, copyPreset: 'standard' as const, storedPrompts: [], constraints: 'Retain every required body.', enhancementMode,
        purpose: 'investigation', requiredSources: [{ kind: 'full', source: { root: 'r', path: 'Main.swift' } },
          { kind: 'slices', source: { root: 'r', path: 'slice.txt' }, ranges: [{ start: 2, end: 2, description: 'selected' }] }],
        documents: [{ kind: 'suppliedDocument', id: 'plan.md', role: 'plan', origin: 'fixture', text: 'Required plan\n```\n🙂\n' }],
        patches: [{ kind: 'suppliedPatch', id: 'changes', root: 'r', origin: 'fixture', text: 'complete patch\n',
          comparison: { kind: 'supplied', base: 'before', target: 'after' }, coverage: [], targets: [
            { path: 'Main.swift', identity: identity(full), mode: '100644' },
            { path: 'Peer.swift', identity: identity('struct Peer { let value: Int }\n'), mode: '100644' },
            { path: 'slice.txt', identity: identity(sliced), mode: '100644' }]  }],
        budgetUnits: 100000, discoveryHints: [], outputName: 'packet' }, signal);
      if (enhancementMode !== 'preserve') await draft.update({ expectedRevision: 0, maxOutputBytes: 30000,
        mutation: { kind: 'prompt', op: enhancementMode === 'augment' ? 'append' : 'set', text: '\nDiscovered details.' } }, signal);
      const costs = await draft.inspect({ view: 'costs', maxOutputBytes: 30000, continuation: null }, signal);
      assert(costs.kind === 'costs');
      const result = await draft.finalize(signal); assert(result.kind === 'ready');
      const context = await readFile(join(result.directory, 'context.md'), 'utf8');
      const treeSpan = result.manifest.fileTree.span;
      const tree = Buffer.from(context).subarray(treeSpan.offset, treeSpan.offset + treeSpan.length).toString();
      const codemap = result.manifest.materials.find(record => record.kind === 'source' && record.selection.kind === 'codemap');
      assert(codemap, 'The automatic dependency must be retained');
      const mapBody = Buffer.from(context).subarray(codemap.spans[0]!.offset, codemap.spans[0]!.offset + codemap.spans[0]!.length).toString();
      const bridge = runtime.makeBridge();
      try {
        const files = [
          { file: { id: 'main', rootID: 'r', name: 'Main.swift', relativePath: 'r/Main.swift', fullPath: 'r/Main.swift' },
            role: 'ordinary' as const, isCodemap: false, loadedContent: full, lineRanges: null, rootFolderPath: null },
          { file: { id: 'slice', rootID: 'r', name: 'slice.txt', relativePath: 'r/slice.txt', fullPath: 'r/slice.txt' },
            role: 'ordinary' as const, isCodemap: false, loadedContent: sliced, lineRanges: [{ start: 2, end: 2, description: 'selected' }], rootFolderPath: null },
          { file: { id: 'map', rootID: 'r', name: 'Peer.swift', relativePath: 'r/Peer.swift', fullPath: 'r/Peer.swift' },
            role: 'ordinary' as const, isCodemap: true, loadedContent: null, lineRanges: null, rootFolderPath: null },
          { file: { id: 'plan', rootID: 'documents', name: 'plan.md', relativePath: 'Plan: fixture (plan.md)', fullPath: 'Plan: fixture (plan.md)' },
            role: 'ordinary' as const, isCodemap: false, loadedContent: 'Required plan\n```\n🙂\n', lineRanges: null, rootFolderPath: null },
        ];
        const reference = await bridge.request({ kind: 'renderClipboard', input: { files,
          codemapPresentation: { renderedEntriesByFileID: { map: { text: mapBody } } }, filePathDisplay: 'full',
          fileTreeContent: tree, gitDiff: 'complete patch\n', metaInstructions: [{ title: 'Constraints', content: 'Retain every required body.' }],
          userInstructions: result.manifest.prompt, includeFiles: true, includeUserPrompt: true, includeSavedPrompts: true,
          includeDatetimeInUserInstructions: false, promptSectionsOrder: ['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions'],
          disabledPromptSections: [], duplicateUserInstructionsAtTop: false, tabTitle: null } }, signal);
        assert.equal(context, reference.result.text);
      } finally { await bridge.close(); }
      assert.equal(costs.measurement.bytes, Buffer.byteLength(context));
      assert.equal(costs.measurement.units, result.manifest.accounting.units);
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
      await writeFile(`test-output/packet-clipboard-${enhancementMode}.json`, JSON.stringify({ directory: result.directory,
        context: identity(context), prompt: result.manifest.prompt, materialSpans: result.manifest.materials.map(record => ({ id: record.id, spans: record.spans })) }, null, 2) + '\n');
      await draft.close(); await workspace.close();
    } finally { await runtime.close(); }
  });
}
