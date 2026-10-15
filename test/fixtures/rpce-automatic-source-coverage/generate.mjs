import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const reference = process.argv[2];
const check = process.argv[3] === '--check';
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!reference || process.argv.length > 4 || (process.argv[3] && !check)) {
  throw Error('Usage: node generate.mjs /absolute/path/to/repoprompt-ce [--check]');
}
const git = (...args) => execFileSync('git', ['-C', resolve(reference), ...args]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
if (git('rev-parse', 'HEAD').toString().trim() !== revision) {
  throw Error('Reference HEAD must equal ' + revision + '; do not reset the checkout.');
}

const base = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/';
const specifications = [
  {
    key: 'graph', path: base + 'WorkspaceCodemapSelectionGraph.swift',
    sha256: 'e821e78a86d96c64601b9801dd9ff70d8671c185f94543930958a405d62171d8',
    ranges: [
      ['sourceSetup', 403, 408], ['sourceClassification', 413, 450],
      ['fileOrdering', 1752, 1770], ['utf8OrderingDelegate', 1781, 1783],
    ],
  },
  {
    key: 'store', path: base + 'WorkspaceFileContextStore.swift',
    sha256: '0c7f382c4f8973cdbb1d0cdf9cd3be2c0f2a4420dd85eee113656cc33deda6e9',
    ranges: [['sourceIssues', 13036, 13053], ['rootStatus', 13133, 13144]],
  },
  {
    key: 'models', path: base + 'Models/WorkspaceCodemapAutomaticSelectionModels.swift',
    sha256: 'd1610e1932afff29aa10eead766733e2f12156679659caa51f39529659877377',
    ranges: [
      ['sourceTypes', 3, 42], ['budgetReasonType', 86, 97], ['coverageTypes', 107, 160],
      ['rootAndAggregateResult', 179, 234], ['resultOrdering', 269, 295],
    ],
  },
  {
    key: 'ordering', path: base + 'WorkspaceCodemapGraphOrdering.swift',
    sha256: 'b0713cc8464c3b75aef17acc0b61166ff51520c0b88618c264e095eba2718594',
    ranges: [['graphOrdering', 1, 42]],
  },
  {
    key: 'license', path: 'LICENSE',
    sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    ranges: [],
  },
];
const sections = {};
const sources = specifications.map(specification => {
  const object = revision + ':' + specification.path;
  const blobByteCount = Number(git('cat-file', '-s', object).toString().trim());
  const bytes = execFileSync('git', ['-C', resolve(reference), 'show', object], { maxBuffer: blobByteCount });
  if (!bytes.equals(readFileSync(join(reference, specification.path))) || hash(bytes) !== specification.sha256) {
    throw Error('Reference blob or working file differs: ' + specification.path);
  }
  const lines = bytes.toString().split('\n');
  const ranges = specification.ranges.map(([name, startLine, endLine]) => {
    const body = lines.slice(startLine - 1, endLine).join('\n') + '\n';
    sections[name] = body;
    return { name, startLine, endLine, sha256: hash(body) };
  });
  if (specification.key === 'license') sections.license = bytes;
  return {
    path: specification.path, gitBlob: git('rev-parse', revision + ':' + specification.path).toString().trim(),
    sha256: hash(bytes), ranges,
  };
});

const original = `// RPCE source excerpts with fixture-only wrappers. See receipt.md and provenance.json.
// Keep extracted bodies verbatim; provenance.json verifies their source hashes.
// swiftlint:disable type_name identifier_name duplicate_imports opening_brace vertical_whitespace
import Foundation

${sections.sourceTypes}
${sections.budgetReasonType}
${sections.coverageTypes}
${sections.rootAndAggregateResult}
${sections.resultOrdering}
${sections.graphOrdering}
enum OriginalSourceClassification {
    static func classify(
        query: WorkspaceCodemapAutomaticSelectionGraphQuery,
        pinned: Pinned
    ) -> [WorkspaceCodemapAutomaticSelectionGraphSource] {
        let snapshot = pinned.snapshot
${sections.sourceSetup}
${sections.sourceClassification}            }
        return sources
    }

${sections.fileOrdering}
${sections.utf8OrderingDelegate}}

// swiftlint:disable:next cyclomatic_complexity
func resolveReadyRoot(
    rootEpoch: WorkspaceCodemapRootEpoch,
    validSources: [WorkspaceCodemapAutomaticSelectionSourceIdentity],
    graphResult: ReadyGraphResult,
    targets: [WorkspaceCodemapAutomaticSelectionTarget]
) -> WorkspaceCodemapAutomaticSelectionRootResult {
    let sourceIssues: [WorkspaceCodemapAutomaticSelectionIssue] = []
    let rootReceipt: WorkspaceCodemapAutomaticSelectionRootReceipt? = WorkspaceCodemapAutomaticSelectionRootReceipt()
${sections.sourceIssues}
${sections.rootStatus}    return makeRootResult(
        rootEpoch: rootEpoch, status: status, targets: targets,
        sources: graphResult.sources, issues: issues, receipt: rootReceipt
    )
}
// swiftlint:enable type_name identifier_name duplicate_imports opening_brace vertical_whitespace
`;

const work = mkdtempSync(join(tmpdir(), 'rpce-source-coverage-'));
const products = new Map([['original-bodies.swift', Buffer.from(original)], ['LICENSE', sections.license]]);
try {
  const originalPath = join(directory, 'original-bodies.swift');
  if (check) {
    if (!readFileSync(originalPath).equals(Buffer.from(original))) throw Error('Source extraction changed');
  } else {
    writeFileSync(originalPath, original);
  }
  execFileSync('swiftc', [
    '-module-name', 'RPCEAutomaticSourceCoverage', join(directory, 'adapter.swift'), originalPath,
    '-o', join(work, 'oracle'),
  ], { stdio: 'inherit' });
  const input = readFileSync(join(directory, 'inputs.json'));
  const output = JSON.parse(execFileSync(join(work, 'oracle'), [], { input }));
  products.set('expected.json', Buffer.from(json(output)));
  const provenance = {
    revision,
    sources,
    artifacts: ['generate.mjs', 'adapter.swift', 'inputs.json'].map(path => ({
      path, sha256: hash(readFileSync(join(directory, path))),
    })).concat([...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))),
    cases: output.length,
    extraction: 'All recorded source ranges are verbatim, including indentation and final LF. Only the surrounding declarations and loop closure are adapters.',
    normalization: 'UUIDs are deterministic fixture identities. Output renders them as declared root labels and source/target paths after original sorting. No status, issue, path or ordering is removed.',
    scope: 'Original selected-source classification, source-issue mapping, ready-root status conditional, result aggregation and ordering. Targets are supplied, not matched or counted by the graph.',
    limits: [
      'No matching, edge traversal, budgets, byte accounting, catalog/slot validation, epochs, currentness, receipt revalidation, demand readiness, IO or app execution.',
      'All classified source generations are zero and current; all sources are unfenced; graph freshness is current and reconciling is false.',
      'Pending and unavailable graph roots are injected aggregate inputs, not executions of store graph-disposition branches.',
      'Empty slots represent readyNoSymbols outcomes, but artifact-to-slot conversion is not executed.',
      'Original Darwin ordering helper requires a macOS Swift toolchain in this extraction.',
    ],
  };
  products.set('provenance.json', Buffer.from(json(provenance)));
  for (const [path, bytes] of products) {
    if (check) {
      if (!readFileSync(join(directory, path)).equals(bytes)) throw Error('Regeneration mismatch: ' + path);
    } else {
      writeFileSync(join(directory, path), bytes);
    }
  }
  process.stdout.write(json({
    mode: check ? 'check' : 'write', cases: output.length,
    result: check ? 'byte-for-byte identical' : 'generated',
    files: [...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  }));
} finally {
  execFileSync('trash', [work]);
}
