import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    path: base + 'WorkspaceFileContextStore.swift',
    sha256: '0c7f382c4f8973cdbb1d0cdf9cd3be2c0f2a4420dd85eee113656cc33deda6e9',
    ranges: [
      ['freeze', 15004, 15178, false], ['render', 15180, 15253, true],
      ['currentness', 16706, 16729, false], ['readyMatches', 16778, 16799, false],
    ],
  },
  {
    path: base + 'Presentation/WorkspaceCodemapPresentationCoordinator.swift',
    sha256: 'fe470879b8d7dc22dfb865c33b58129873eace7a530ab5d364718a016e98e7c2',
    ranges: [
      ['grouping', 435, 458, true], ['rootLoop', 460, 494, true], ['coverage', 859, 880, true],
    ],
  },
  {
    path: 'Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+SelectionCore.swift',
    sha256: 'c20df35cec64f83134b340d205ad809d323dae0d68eed48b8a2037a47ad94539',
    ranges: [
      ['diagnosticModels', 310, 327, true], ['missingDiagnostics', 344, 373, true],
      ['missingClassifiers', 386, 487, true], ['candidateClassifier', 489, 502, true],
      ['freezeClassifier', 591, 600, true], ['renderClassifier', 602, 613, true],
    ],
  },
  {
    path: base + 'Models/WorkspaceCodemapPresentationModels.swift',
    sha256: 'dd75c1a006878c78e6846b2cf7367b95798cd071dc9fc812ffacd246f0f9eab4',
    ranges: [['presentationModels', 35, 125, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapArtifactDemandModels.swift',
    sha256: 'f8b9ac62fc6c239cd83285e6dc91cf6072f58572b9d66099a5c4b4abe93cc17b',
    ranges: [['demandResult', 37, 41, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapLiveOverlayModels.swift',
    sha256: 'da7b3f215ee51c92be36002a5e502331b69bc86da4551c3ed821bb2797438595',
    ranges: [['artifactOutcomes', 110, 126, true], ['handleAccess', 389, 426, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapOperationPresentationModels.swift',
    sha256: 'a7167fd8d1267097a6dfcc61f975971a8c29485b529b7ed997113683daf6ab81',
    ranges: [['candidateIssues', 22, 27, true], ['operationModels', 41, 80, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapArtifactModels.swift',
    sha256: '8225768e56e0bddd91fc9eebe0d7ea4851eedf522d69f3a34b2da9532da41e87',
    ranges: [['renderedCodemap', 500, 503, true]],
  },
  {
    path: 'Sources/RepoPrompt/Features/CodeMap/CodeMapArtifactPresentationAdapter.swift',
    sha256: '01b4975af6923c123d753a1fa5d6117d4a1500d7892ea27ffe2e73ce246ef684',
    ranges: [['formatter', 11, 13, true]],
  },
  {
    path: base + 'TokenAccounting/TokenCalculationService.swift',
    sha256: 'e36ff5d3787f2bc9696c51ad81bfc717cb76ef0ea45bc619272cf0717a951d6b',
    ranges: [['tokenEstimator', 132, 142, true]],
  },
  {
    path: 'LICENSE', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    ranges: [],
  },
];

const sections = {};
const referenceOnly = [];
const sources = specifications.map(specification => {
  const object = revision + ':' + specification.path;
  const size = Number(git('cat-file', '-s', object).toString().trim());
  const bytes = execFileSync('git', ['-C', resolve(reference), 'show', object], { maxBuffer: size });
  if (!bytes.equals(readFileSync(join(reference, specification.path))) || hash(bytes) !== specification.sha256) {
    throw Error('Reference blob or working file differs: ' + specification.path);
  }
  const lines = bytes.toString().split('\n');
  const ranges = specification.ranges.map(([name, startLine, endLine, compiled]) => {
    const body = lines.slice(startLine - 1, endLine).join('\n') + '\n';
    sections[name] = body;
    if (!compiled) referenceOnly.push(`// ${specification.path}:${startLine}-${endLine}\n${body}`);
    return { name, startLine, endLine, sha256: hash(body), compiled };
  });
  if (specification.path === 'LICENSE') sections.license = bytes;
  return {
    path: specification.path, gitBlob: git('rev-parse', object).toString().trim(),
    sha256: hash(bytes), ranges,
  };
});

const original = `// Extracted from RepoPrompt CE. Original ranges are verbatim inside fixture wrappers.
// Store, handle storage and runtime adapters are defined in adapter.swift. See receipt.md and LICENSE.
${sections.presentationModels}
${sections.demandResult}
${sections.artifactOutcomes}
${sections.candidateIssues}
${sections.operationModels}
${sections.renderedCodemap}
enum CodeMapAPIContentFormatter {
${sections.formatter}
}

enum TokenCalculationService {
${sections.tokenEstimator}
}

extension WorkspaceCodemapLiveFrozenArtifactHandle {
${sections.handleAccess}
}

extension FixtureStore {
${sections.render}
}

struct OriginalCoordinator {
    func run(
        candidates: [FixtureCandidate], demandBatch: FixtureDemandBatch, store: FixtureStore
    ) async throws -> WorkspaceCodemapOperationPresentation {
        var issues: [WorkspaceCodemapOperationIssue] = []
        let ownership = FixtureOwnership()
${sections.grouping}
${sections.rootLoop}
        return WorkspaceCodemapOperationPresentation(
            entries: renderedEntries, issues: issues,
            coverage: coverage(for: renderedEntries, issues: issues), bundleReceipts: bundleReceipts
        )
    }

    func structurePhaseDidChange(_ phase: FixturePhase) async {}

${sections.coverage}
}

enum OriginalSelectionCore {
${sections.diagnosticModels}
${sections.missingDiagnostics}
${sections.missingClassifiers}
${sections.candidateClassifier}
${sections.freezeClassifier}
${sections.renderClassifier}
    private static func unavailableDisposition(
        _ reason: WorkspaceCodemapArtifactDemandUnavailableReason
    ) -> CodemapIssueDisposition {
        preconditionFailure("Only ready demand inputs are supported by this fixture")
    }

    private static func automaticCoverageDisposition(
        _ coverage: WorkspaceCodemapAutomaticSelectionAggregateCoverage, fileID: UUID
    ) -> CodemapIssueDisposition? {
        preconditionFailure("Automatic selection is not an input to this fixture")
    }
}
`;

const products = new Map([
  ['original-bodies.swift.txt', Buffer.from(original)],
  ['reference-only.swift.txt', Buffer.from(
    '// Uncompiled original source. These functions are replaced by the adapters in adapter.swift.\n'
      + referenceOnly.join('\n'),
  )],
  ['LICENSE', sections.license],
]);
const work = mkdtempSync(join(directory, '.work-'));
try {
  const combined = Buffer.concat([
    readFileSync(join(directory, 'adapter.swift')), Buffer.from('\n'), Buffer.from(original),
  ]);
  const source = join(work, 'fixture.swift');
  const executable = join(work, 'fixture');
  writeFileSync(source, combined);
  const env = {
    ...process.env, TMPDIR: work, CLANG_MODULE_CACHE_PATH: join(work, 'module-cache'),
    SWIFT_MODULE_CACHE_PATH: join(work, 'module-cache'), LLVM_PROFILE_FILE: join(work, '%p.profraw'),
  };
  execFileSync('swiftc', [
    '-parse-as-library', '-module-name', 'RPCERootPresentationRender',
    '-module-cache-path', join(work, 'module-cache'), source, '-o', executable,
  ], { stdio: 'inherit', env });
  const output = JSON.parse(execFileSync(executable, [], {
    input: readFileSync(join(directory, 'inputs.json')), env,
  }));
  products.set('expected.json', Buffer.from('[\n' + output.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n'));
  const provenance = {
    revision, sources, cases: output.length,
    artifacts: ['generate.mjs', 'adapter.swift', 'inputs.json', 'receipt.md'].map(path => ({
      path, sha256: hash(readFileSync(join(directory, path))),
    })).concat([...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))),
    combinedCompilationSHA256: hash(combined),
    extraction: 'Each range is verbatim, including indentation and final LF. Fixture declarations surround original ranges.',
    compiled: 'Full root renderer; ready-result grouping and per-root freeze/render loop; handle key, outcome and renderer; missing-file diagnostics and render classifiers; formatter and token estimator; listed model declarations.',
    adapters: [
      'Freeze constructs retained ready bundles from seeded entries and handles. Original freeze is reference-only.',
      'Root epochs and artifact keys are string labels; tickets retain only file ID and root label; logical paths hold display labels.',
      'Ready matching checks modeled entry and ticket equality instead of production identity, snapshots or generations.',
      'Currentness is explicitly current, stale at first render check, or stale at the second check during final revalidation.',
      'Handle state synchronously returns a seeded syntax outcome or throws for revoked access. There are no real locks or lease owners.',
      'Only ready and readyNoSymbols can be decoded as input outcomes. Terminal syntax enum variants exist only to compile original outcome mapping.',
      'Swift support is asserted by an adapter. Classifiers for automatic selection and issues from non-ready demands fail fast if reached.',
      'Ownership and phase hooks are no-ops. Root ordering compares labels. Post-loop sorting, publication and MCP reply assembly are not executed.',
    ],
    limits: [
      'No real cancellation, acquisition engine, security or root IO, authority or epoch validation, watchers, lease revocation, publication or app runtime is exercised.',
      'Stale and revoked states are injected after modeled freeze admission, not produced by transitions in the production lifecycle.',
      'No claim is made that oversize, decodeFailed or parseFailed terminal-unavailable artifacts enter a frozen ready bundle.',
      'Bundle retention/metadata failures, key/outcome mismatch, and real concurrent invalidation are not exercised.',
      'Pending and unmapped are outputs from the original classifier for missing supported files, not observed provider replies or retention guarantees.',
    ],
    normalization: 'Emit ordered root labels, rendered display paths, render reason/file and missing-file diagnostics. Omit opaque bundle UUIDs, fixture artifact text/token counts, timings and compiler paths.',
    license: 'Apache-2.0; LICENSE is copied byte-for-byte from the pinned checkout.',
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
