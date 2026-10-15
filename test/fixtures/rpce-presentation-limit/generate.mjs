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
      ['entryLimit', 373, 373, true], ['entryGuardPrefix', 15004, 15016, true],
      ['freezeRemainder', 15018, 15178, false], ['render', 15180, 15253, false],
    ],
  },
  {
    path: base + 'Presentation/WorkspaceCodemapPresentationCoordinator.swift',
    sha256: 'fe470879b8d7dc22dfb865c33b58129873eace7a530ab5d364718a016e98e7c2',
    ranges: [['grouping', 435, 458, true], ['rootFreezeRenderLoop', 462, 494, false]],
  },
  {
    path: 'Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+SelectionCore.swift',
    sha256: 'c20df35cec64f83134b340d205ad809d323dae0d68eed48b8a2037a47ad94539',
    ranges: [['issueDisposition', 324, 327, true], ['freezeClassifier', 591, 600, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapPresentationModels.swift',
    sha256: 'dd75c1a006878c78e6846b2cf7367b95798cd071dc9fc812ffacd246f0f9eab4',
    ranges: [['request', 35, 38, true], ['freezeDispositions', 93, 112, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapArtifactDemandModels.swift',
    sha256: 'f8b9ac62fc6c239cd83285e6dc91cf6072f58572b9d66099a5c4b4abe93cc17b',
    ranges: [['demandResult', 37, 41, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapLiveOverlayModels.swift',
    sha256: 'da7b3f215ee51c92be36002a5e502331b69bc86da4551c3ed821bb2797438595',
    ranges: [['artifactOutcomes', 110, 126, false], ['handleRenderer', 411, 426, false]],
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

const original = `// Extracted from RepoPrompt CE; fixture wrappers and a modeled success return are added.
// Recorded original ranges are verbatim. See receipt.md, provenance.json and LICENSE.
${sections.request}
${sections.demandResult}
${sections.freezeDispositions}
struct OriginalEntryGuard {
${sections.entryLimit}
${sections.entryGuardPrefix}
        // Fixture boundary: Store line 15018 and every later freeze check are unexecuted.
        return .ready(WorkspaceCodemapFrozenPresentationBundle())
    }
}

enum OriginalGrouping {
    static func group(
        candidates: [FixtureCandidate], demandBatch: FixtureDemandBatch
    ) -> [WorkspaceCodemapRootEpoch: [WorkspaceCodemapPresentationRequest]] {
        var issues: [FixtureIssue] = []
${sections.grouping}
        precondition(issues.isEmpty, "Fixture inputs must be matching-root ready results")
        return requestsByRoot
    }
}

enum OriginalSelectionCore {
${sections.issueDisposition}
${sections.freezeClassifier}
    static func fixtureClassification(_ reason: WorkspaceCodemapPresentationFreezeUnavailableReason) -> String {
        switch freezeUnavailableDisposition(reason) {
        case .pending: return "pending"
        case let .unmapped(terminal): return terminal ? "terminalUnmapped" : "unmapped"
        }
    }
}
`;
const products = new Map([
  ['original-bodies.swift.txt', Buffer.from(original)],
  ['reference-only.swift.txt', Buffer.from(
    '// Uncompiled original RPCE excerpts. No execution claims apply to these bodies.\n'
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
    '-parse-as-library', '-module-name', 'RPCEPresentationEntryLimit',
    '-module-cache-path', join(work, 'module-cache'), source, '-o', executable,
  ], { stdio: 'inherit', env });
  const output = JSON.parse(execFileSync(executable, [], {
    input: readFileSync(join(directory, 'inputs.json')), env,
  }));
  products.set('expected.json', Buffer.from(json(output)));
  const cases = output.directGuardCases.length + output.groupedReadyCases.length;
  const provenance = {
    revision, sources,
    artifacts: ['generate.mjs', 'adapter.swift', 'inputs.json', 'receipt.md'].map(path => ({
      path, sha256: hash(readFileSync(join(directory, path))),
    })).concat([...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))),
    combinedCompilationSHA256: hash(combined), cases,
    extraction: 'Recorded ranges retain original bytes, indentation and final LF; fixture declarations surround compiled ranges.',
    compiled: 'Original 4096 constant, freeze entry guard prefix, ready-result grouping, request/result/freeze enums, and freeze-unavailable classifier.',
    boundary: 'After Store line 15016, return an empty fixture ready bundle. Original freeze resumes at line 15018 and is not executed.',
    adapters: [
      'Root epochs and logical paths are string labels; tickets contain only root epoch and deterministic file ID.',
      'Ready results contain an injected outcome label instead of snapshots, handles, identity or leases.',
      'The synchronous sorted root loop calls the original entry guard once per group; original async freeze/render loop is reference-only.',
      'No DEBUG flag is passed, so the original testing-counter increment is excluded by its own conditional compilation.',
    ],
    limits: [
      'Admitted means the entry guard passed into modeled success, not that a real bundle froze or rendered.',
      'readyNoSymbols is injected as an already-ready demand result; its nonrenderability is supported by the uncompiled original handle renderer.',
      'No execution of acquisition, currentness, duplicate/root checks, retained-record limits, retention, cancellation, rendering, publication or MCP reply assembly.',
      'Pending is the original freeze-issue classifier output, not an observed provider response or retained-demand guarantee.',
      'Healthy-root independence is grouping and entry-guard independence only; no end-to-end rendering claim is made.',
    ],
    normalization: 'Only counts, case names and epoch labels are emitted. No per-request arrays, random IDs, timings or compiler paths appear in expected JSON.',
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
    mode: check ? 'check' : 'write', cases,
    result: check ? 'byte-for-byte identical' : 'generated',
    files: [...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  }));
} finally {
  execFileSync('trash', [work]);
}
