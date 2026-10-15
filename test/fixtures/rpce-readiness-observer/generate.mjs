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
    path: base + 'Presentation/WorkspaceCodemapPresentationCoordinator.swift',
    sha256: 'fe470879b8d7dc22dfb865c33b58129873eace7a530ab5d364718a016e98e7c2',
    ranges: [
      ['policyAndWaiter', 3, 50], ['ownership', 52, 113], ['demandBatch', 142, 146],
      ['demand', 666, 794], ['ticket', 796, 804], ['wait', 830, 847], ['release', 849, 857],
    ],
  },
  {
    path: base + 'WorkspaceFileContextStore.swift',
    sha256: '0c7f382c4f8973cdbb1d0cdf9cd3be2c0f2a4420dd85eee113656cc33deda6e9',
    ranges: [
      ['completionLatch', 559, 670],
      ['storeWaitReferenceOnly', 14483, 14502], ['storeCancellationReferenceOnly', 15441, 15519],
    ],
  },
  {
    path: 'LICENSE', sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    ranges: [],
  },
];
const sections = {};
const sources = specifications.map(specification => {
  const object = revision + ':' + specification.path;
  const size = Number(git('cat-file', '-s', object).toString().trim());
  const bytes = execFileSync('git', ['-C', resolve(reference), 'show', object], { maxBuffer: size });
  if (!bytes.equals(readFileSync(join(reference, specification.path))) || hash(bytes) !== specification.sha256) {
    throw Error('Reference blob or working file differs: ' + specification.path);
  }
  const lines = bytes.toString().split('\n');
  const ranges = specification.ranges.map(([name, startLine, endLine]) => {
    const body = lines.slice(startLine - 1, endLine).join('\n') + '\n';
    sections[name] = body;
    return { name, startLine, endLine, sha256: hash(body), compiled: !name.endsWith('ReferenceOnly') };
  });
  if (specification.path === 'LICENSE') sections.license = bytes;
  return {
    path: specification.path, gitBlob: git('rev-parse', object).toString().trim(),
    sha256: hash(bytes), ranges,
  };
});

const original = `// Verbatim RPCE ranges inside fixture declarations. See receipt.md and provenance.json.
import Foundation

${sections.policyAndWaiter}
${sections.ownership}
extension WorkspaceFileContextStore {
${sections.completionLatch}}

struct OriginalCoordinator {
    let store: WorkspaceFileContextStore
    let policy: WorkspaceCodemapPresentationRequestPolicy
    let waiter: WorkspaceCodemapPresentationWaiter

${sections.demandBatch}
${sections.demand}
${sections.ticket}
${sections.wait}
${sections.release}
    // Fixture entrypoint, not RPCE's withPresentation preparation, rendering or publication flow.
    func observeFixture(fileIDs: [UUID]) async throws -> FixtureDemandBatch {
        let ownership = WorkspaceCodemapOperationPresentationOwnership()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: policy.maximumTotalWait)
        do {
            let batch = try await demand(
                fileIDs: fileIDs, priority: .demand, ownership: ownership,
                clock: clock, deadline: deadline
            )
            let beforeRelease = await store.observations(fileIDs)
            await release(ownership)
            return FixtureDemandBatch(
                resultsByFileID: batch.resultsByFileID,
                deadlineReached: batch.deadlineReached,
                defensiveRoundLimitReached: batch.defensiveRoundLimitReached,
                beforeRelease: beforeRelease
            )
        } catch {
            await release(ownership)
            throw error
        }
    }
}
`;
const referenceOnly = `// Reference only: these original Store bodies are not compiled by this fixture.
// Retain removal is modeled by adapter.swift; full Store cleanup is outside the execution scope.
${sections.storeWaitReferenceOnly}
${sections.storeCancellationReferenceOnly}`;
const products = new Map([
  ['original-bodies.swift.txt', Buffer.from(original)],
  ['store-reference-only.swift.txt', Buffer.from(referenceOnly)], ['LICENSE', sections.license],
]);
const work = mkdtempSync(join(directory, '.work-'));
try {
  const adapter = readFileSync(join(directory, 'adapter.swift'));
  const combined = Buffer.concat([adapter, Buffer.from('\n'), Buffer.from(original)]);
  const source = join(work, 'fixture.swift');
  const executable = join(work, 'fixture');
  writeFileSync(source, combined);
  const env = {
    ...process.env, TMPDIR: work, CLANG_MODULE_CACHE_PATH: join(work, 'module-cache'),
    SWIFT_MODULE_CACHE_PATH: join(work, 'module-cache'), LLVM_PROFILE_FILE: join(work, '%p.profraw'),
  };
  execFileSync('swiftc', [
    '-parse-as-library', '-module-name', 'RPCEReadinessObserver', '-module-cache-path', join(work, 'module-cache'),
    source, '-o', executable,
  ], { stdio: 'inherit', env });
  const input = readFileSync(join(directory, 'inputs.json'));
  const output = JSON.parse(execFileSync(executable, [], { input, env }));
  products.set('expected.json', Buffer.from(json(output)));
  const provenance = {
    revision, sources,
    artifacts: ['generate.mjs', 'adapter.swift', 'inputs.json'].map(path => ({
      path, sha256: hash(readFileSync(join(directory, path))),
    })).concat([...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))),
    combinedCompilationSHA256: hash(combined), cases: output.length,
    productionWaitMilliseconds: 10000,
    injectedPendingWaitMilliseconds: 50,
    extraction: 'Every recorded range is verbatim, including indentation and final LF. Fixture declarations surround the ranges.',
    scope: 'Original coordinator policy, ownership actor, demand, ticket, wait and release bodies; original Store completion latch. Retainer removal is modeled, not original Store cancellation execution.',
    normalization: 'Random retain UUIDs are not emitted. File labels and input order identify observations. No elapsed-time measurement is used as an end-to-end duration claim.',
    limits: [
      'Store request, status, completion publication and retain cancellation are fixture adapters with gated tasks, not app code.',
      'Store cancellation and cleanup at 15441-15519 and its wait API at 14483-14502 are retained as uncompiled reference excerpts.',
      'No app execution or proof of MCP duration bounds, matching, currentness, busy/retry equivalence, rendering, freezing, root setup or engine cleanup.',
      'The short injected policy exercises the original deadline algorithm; production remains 10000ms.',
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
    outcomes: output.map(({ name, statuses, deadlineReached }) => ({ name, statuses, deadlineReached })),
    files: [...products].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  }));
} finally {
  execFileSync('trash', [work]);
}
