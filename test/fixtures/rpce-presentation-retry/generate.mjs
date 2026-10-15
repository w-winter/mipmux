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
const artifact = (path, bytes) => ({
  path, sha256: hash(bytes),
  gitBlob: execFileSync('git', ['hash-object', '--stdin'], { input: bytes, cwd: directory }).toString().trim(),
});
if (git('rev-parse', 'HEAD').toString().trim() !== revision) {
  throw Error('Reference HEAD must equal ' + revision + '; do not reset the checkout.');
}

const base = 'Sources/RepoPrompt/Infrastructure/WorkspaceContext/';
const specifications = [
  {
    path: base + 'Presentation/WorkspaceCodemapPresentationCoordinator.swift',
    sha256: 'fe470879b8d7dc22dfb865c33b58129873eace7a530ab5d364718a016e98e7c2',
    ranges: [
      ['policyAndWaiter', 3, 50, true], ['ownership', 52, 113, true],
      ['attempt', 126, 132, true], ['intentWrapper', 208, 233, true],
      ['attemptWrapper', 235, 345, true], ['release', 849, 857, true],
      ['coverage', 859, 880, true], ['incomplete', 882, 892, true],
      ['preservingPriorStale', 894, 916, true], ['retryableStale', 918, 947, true],
      ['makePresentationSignature', 347, 354, false], ['receiptConstruction', 495, 532, false],
    ],
  },
  {
    path: base + 'Models/WorkspaceCodemapOperationPresentationModels.swift',
    sha256: 'a7167fd8d1267097a6dfcc61f975971a8c29485b529b7ed997113683daf6ab81',
    ranges: [['operationModels', 4, 142, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapArtifactDemandModels.swift',
    sha256: 'f8b9ac62fc6c239cd83285e6dc91cf6072f58572b9d66099a5c4b4abe93cc17b',
    ranges: [['ticket', 3, 12, true], ['demandResultAndOwnership', 37, 52, true]],
  },
  {
    path: base + 'Models/WorkspaceCodemapPresentationModels.swift',
    sha256: 'dd75c1a006878c78e6846b2cf7367b95798cd071dc9fc812ffacd246f0f9eab4',
    ranges: [['freezeReasons', 93, 107, true], ['renderReasons', 114, 120, true]],
  },
  {
    path: 'Sources/RepoPrompt/Infrastructure/MCP/ViewModels/MCPServerViewModel+SelectionCore.swift',
    sha256: 'c20df35cec64f83134b340d205ad809d323dae0d68eed48b8a2037a47ad94539',
    ranges: [['selectionCaller', 651, 738, false]],
  },
  {
    path: 'Sources/RepoPrompt/Features/AgentMode/Services/AgentContextExportResolver.swift',
    sha256: '138b9c5f837bd5c4f6db2b34b527742fcad18784cef01c56832f8b36ab4b8288',
    ranges: [['alternateExportCaller', 575, 593, false], ['alternateRequestedCount', 907, 914, false]],
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
    return { name, startLine, endLine, compiled, sha256: hash(body) };
  });
  if (specification.path === 'LICENSE') sections.license = bytes;
  return {
    path: specification.path, gitBlob: git('rev-parse', object).toString().trim(),
    sha256: hash(bytes), ranges,
  };
});

const original = `// Verbatim RPCE ranges inside fixture declarations. See receipt.md and provenance.json.
${sections.policyAndWaiter}
${sections.ownership}
${sections.attempt}
${sections.operationModels}
${sections.ticket}
${sections.demandResultAndOwnership}
${sections.freezeReasons}
${sections.renderReasons}
@MainActor private struct OriginalCoordinator {
    let store: WorkspaceFileContextStore
    let policy: WorkspaceCodemapPresentationRequestPolicy
    let waiter: WorkspaceCodemapPresentationWaiter
    let beforePublicationRevalidation: (WorkspaceCodemapOperationPresentationPublicationReceipt) async -> Void
    let runtime: FixtureRuntime

${sections.intentWrapper}
${sections.attemptWrapper}
${sections.release}
${sections.coverage}
${sections.incomplete}
${sections.preservingPriorStale}
${sections.retryableStale}}
`;
const products = new Map([
  ['original-bodies.swift.txt', Buffer.from(original)],
  ['reference-only.swift.txt', Buffer.from('// Uncompiled original source for caller and adapter context.\n' + referenceOnly.join('\n'))],
  ['LICENSE', sections.license],
]);
const work = mkdtempSync(join(directory, '.work-'));
try {
  const combined = Buffer.concat([
    readFileSync(join(directory, 'models.swift')), Buffer.from('\n'),
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
    '-parse-as-library', '-module-name', 'RPCEOuterPresentationRetry',
    '-module-cache-path', join(work, 'module-cache'), source, '-o', executable,
  ], { stdio: 'inherit', env, cwd: work });
  const output = JSON.parse(execFileSync(executable, [], {
    input: readFileSync(join(directory, 'inputs.json')), env, cwd: work,
  }));
  products.set('expected.json', Buffer.from('[\n' + output.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n'));
  const provenance = {
    revision, sources, cases: output.length,
    artifacts: ['generate.mjs', 'models.swift', 'adapter.swift', 'inputs.json', 'receipt.md'].map(path =>
      artifact(path, readFileSync(join(directory, path)))
    ).concat([...products].map(([path, bytes]) => artifact(path, bytes))),
    combinedCompilationSHA256: hash(combined),
    productionWaitMilliseconds: 10000,
    extraction: 'Every recorded range is verbatim, including indentation and final LF. Fixture declarations surround compiled ranges.',
    clock: 'A fixture-local ContinuousClock shadows Swift.ContinuousClock. Scripted waiter calls advance integer milliseconds; original wrapper policy remains default.',
    normalization: 'UUIDs become attempt-local resource and receipt labels; output retains operation calls, return selection, readiness deadline and release order. Compiler paths, presentation IDs, text and token counts are omitted.',
    limits: [
      'makePresentation, publication disposition and operation results are scripted adapters, not real rendering, Store validation or reply assembly.',
      'SelectionCore and alternate export callers are uncompiled context. Actual selection, usage and plan resolution is not executed.',
      'Store release calls remove fixture resource IDs; original ownership drain and coordinator release execute, not production Store cancellation or lease cleanup.',
      'Clock and wait injection prove wrapper deadline reuse and retry gates, not production readiness waits or end-to-end MCP duration.',
      'Only render staleCurrentness and noRenderableCodemap are input render issues; other original retry classifier branches compile but are not exercised.',
      'No provider, app, project build, production/test edit, Git index operation or commit is part of generation.',
    ],
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
    outcomes: output.map(({ name, outcome }) => ({ name, outcome })),
    files: [...products].map(([path, bytes]) => artifact(path, bytes)),
  }));
} finally {
  execFileSync('trash', [work]);
}
