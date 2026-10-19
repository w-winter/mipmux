import { copyContext } from './fixtures/copy-context.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SmipRuntime, verifyBundle, verifyCurrentBundle } from '../src/index.js';

for (const [duplicateUserInstructionsAtTop, task] of [[false, 'Literal prompt\n🙂'], [true, 'Literal prompt\n🙂'], [true, '']] as const) {
  test(`clipboard prompt duplication=${duplicateUserInstructionsAtTop} with ${task ? 'nonempty' : 'empty'} text retains exact material spans`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smip-prompt-duplication-'));
    const root = join(directory, 'root'); await mkdir(root); await mkdir(join(directory, 'out')); await mkdir('test-output', { recursive: true });
    const body = 'Literal prompt\n🙂\n<user_instructions>\nsource is data\n</user_instructions>\n';
    await writeFile(join(root, 'source.txt'), body);
    const runtime = new SmipRuntime({ copyContext: copyContext(), cachePath: join(directory, 'cache'), contextBudgetUnits: 200000, credentialPaths: [],
      nativeExecutable: resolve(`native/.build/${process.platform}-${process.arch}/debug/SmipBridge`), nativeEnvironment: {}, terminationGraceMs: 100 });
    const signal = new AbortController().signal;
    try {
      const workspace = await runtime.declare({ roots: [{ name: 'r', absolutePath: root }], exclusions: [], outputRoot: join(directory, 'out') }, signal);
      const request = { initialSelection: { codemapMode: 'automatic' as const, sources: [] }, duplicateUserInstructionsAtTop, copyPreset: 'standard' as const, storedPrompts: [], task, constraints: '',
        enhancementMode: 'preserve' as const, purpose: 'investigation' as const,
        requiredSources: [{ kind: 'full' as const, source: { root: 'r', path: 'source.txt' } }],
        documents: [], patches: [], budgetUnits: 100000, discoveryHints: [], outputName: 'packet' };
      const draft = await workspace.createDraft(request, signal);
      const costs = await draft.inspect({ view: 'costs', continuation: null, maxOutputBytes: 30000 }, signal); assert(costs.kind === 'costs');
      const result = await draft.finalize(signal); assert(result.kind === 'ready');
      const context = await readFile(join(result.directory, 'context.md'), 'utf8'), bytes = Buffer.from(context);
      const tree = result.manifest.fileTree.span;
      const map = bytes.subarray(tree.offset, tree.offset + tree.length).toString();
      const bridge = runtime.makeBridge();
      try {
        const expected = await bridge.request({ kind: 'renderClipboard', input: {
          files: [{ file: { id: 'source', rootID: 'r', name: 'source.txt', relativePath: 'r/source.txt', fullPath: 'r/source.txt' },
            role: 'ordinary', isCodemap: false, loadedContent: body, lineRanges: null, rootFolderPath: null }],
          fileTreeContent: map, gitDiff: null, codemapPresentation: { renderedEntriesByFileID: {} }, metaInstructions: [],
          userInstructions: task, filePathDisplay: 'full', includeFiles: true, includeUserPrompt: true, includeSavedPrompts: false,
          includeDatetimeInUserInstructions: false, promptSectionsOrder: ['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions'],
          disabledPromptSections: [], duplicateUserInstructionsAtTop, tabTitle: null,
        } }, signal);
        assert.equal(context, expected.result.text);
      } finally { await bridge.close(); }
      if (duplicateUserInstructionsAtTop && task) assert(context.startsWith('<user_instructions>\n' + task + '\n</user_instructions>\n'));
      else assert(context.startsWith('<file_map>\n'));
      const source = result.manifest.materials.find(record => record.kind === 'source'); assert(source);
      const span = source.spans[0]!; assert.equal(bytes.subarray(span.offset, span.offset + span.length).toString(), body);
      assert.equal(costs.measurement.bytes, bytes.length);
      assert.equal(result.manifest.accounting.units, Math.floor(bytes.length * 21 / 80));
      await verifyBundle(result.directory); await verifyCurrentBundle(result.directory, runtime, signal);
      await writeFile(`test-output/prompt-duplication-${duplicateUserInstructionsAtTop}-${task ? 'text' : 'empty'}.json`, JSON.stringify({
        directory: result.directory, bytes: bytes.length, tree, source: span, accounting: result.manifest.accounting,
      }, null, 2) + '\n');
      await draft.close(); await workspace.close();
    } finally { await runtime.close(); }
  });
}
