import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runReference } from './reference-harness.mjs';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-selection-candidate-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-selection-candidates/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = (index, start, end) => {
  const entry = provenance.sources[index], bytes = readFileSync(resolve(checkout, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  const text = start === undefined ? bytes.toString() : bytes.toString().split('\n').slice(start - 1, end).join('\n');
  return text.replaceAll('package ', '').replaceAll('import RepoPromptFoundation\n', '')
    .replaceAll('import RepoPromptWorkspaceCore\n', '').replaceAll('import RepoPromptFileSystem\n', '');
};
const pathProof = JSON.parse(readFileSync('test/fixtures/rpce-path-match/provenance.json'));
for (const entry of pathProof.sources) if (!provenance.sources.some(saved => saved.path === entry.path)) provenance.sources.push(entry);
const syntaxPath = 'Sources/RepoPromptCodeMapCore/CodeMapSyntaxEngine.swift';
if (!provenance.sources.some(entry => entry.path === syntaxPath)) provenance.sources.push({ path: syntaxPath,
  sha256: createHash('sha256').update(readFileSync(resolve(checkout, syntaxPath))).digest('hex') });
const index = path => provenance.sources.findIndex(entry => entry.path === path);
const adapter = path => readFileSync('native/Sources/MipmuxBridge/' + path, 'utf8');
const wire = adapter('Wire.swift');
const helpers = adapter('RPCESelectionCandidateModels.swift').slice(adapter('RPCESelectionCandidateModels.swift').indexOf('enum WorkspaceLookupRootScope'));
const syntaxIndex = index(syntaxPath);
const sliceProof = JSON.parse(readFileSync('test/fixtures/rpce-selection-transitions/provenance.json'));
for (const entry of sliceProof.sources) if (!provenance.sources.some(saved => saved.path === entry.path)) provenance.sources.push(entry);
const sourceSelection = source(0, 5, 26) + '\n}';
const lineRange = source(index('Sources/RepoPromptFoundation/Slices/LineRange.swift'));
const normalization = source(index('Sources/RepoPromptFoundation/Utilities/WorkspacePathNormalizations.swift'))
  .split('enum GitDiffPathNormalization')[0].replace('@_exported ', '');
const ordinaryMethods = source(0, 238, 381) + '\n' + source(0, 461, 787) + '\n' + source(0, 1349, 1375);
const stateAdapter = adapter('SelectionTransitionInput.swift').slice(adapter('SelectionTransitionInput.swift').indexOf('extension StoredSelection'));
const lineAdapter = adapter('SliceRangesInput.swift').split('struct SliceRangesInput')[0];
const extensionMap = (source(syntaxIndex, 91, 105) + "\n" + source(syntaxIndex, 117, 119)).replace('[String: LanguageType]', '[String: String]')
  .replace(/: \.([a-z_]+)(,?)/g, (_, language, comma) => ': "' + language + '"' + comma);
const parseDirectory = 'test/fixtures/rpce-selection-input-parsing/';
const parseProof = JSON.parse(readFileSync(parseDirectory + 'provenance.json'));
const parserSource = readFileSync(resolve(checkout, parseProof.source.path));
if (createHash('sha256').update(parserSource).digest('hex') !== parseProof.source.sha256) throw new Error('Parser source modified.');
const sdkCheckout = resolve(checkout, '.build/checkouts/swift-sdk');
if (execFileSync('git', ['-C', sdkCheckout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== parseProof.sdkRevision) throw new Error('SDK revision differs.');
const sdkSources = parseProof.sdkSources.map(entry => {
  const bytes = readFileSync(resolve(sdkCheckout, entry.path));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('SDK source modified.');
  return bytes.toString();
});
const candidateBody = source(0, 788, 924) + '\n' + source(0, 1278, 1348) + '\n' + source(0, 1377, 1400);
const catalogFileLookup = source(2, 18389, 18500);
const text = [
  'import CoreFoundation\nimport Foundation',
  ...sdkSources,
  parserSource.toString().replace('import MCP\n', '').replace('import RepoPromptFoundation\n', '')
    .replace('extension MCPServerViewModel', 'struct RPCESelectionInputParser').replaceAll('nonisolated ', ''),
  'typealias SelectionJSONValue = Value',
  ...pathProof.sources.map(entry => source(index(entry.path))),
  source(1, 1, 164) + '\n' + source(1, 237, 369),
  sourceSelection, lineRange, normalization, lineAdapter,
  source(0, 55, 94), stateAdapter,
  source(index('Sources/RepoPromptFoundation/Slices/SliceRangeMath.swift')),
  source(3, 92, 104) + '\n' + source(3, 430, 441) + '\n' + source(3, 481, 544), helpers,
  'enum CodeMapSyntaxEngine {\n' + extensionMap.replace('    init() {}', '') + '\n}',
  'enum SyntaxManager { static func supportsCodeMap(fileExtension: String) -> Bool { CodeMapSyntaxEngine.supportsCodeMap(fileExtension: fileExtension) } }',
  wire.slice(wire.indexOf('struct BridgeFailure'), wire.indexOf('struct SourceIdentity')),
  `struct PathMatchInput { static func relativePath(_ path: String) throws {
    guard !path.isEmpty, !path.hasPrefix("/"), !StandardizedPath.containsNUL(path),
      path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
      StandardizedPath.relative(path) == path else { throw BridgeFailure("nativeProtocolError") }
  } }`,
  adapter('CapturedSelectionCatalog.swift'), adapter('SelectionCatalog.swift'), adapter('SelectionCandidatesInput.swift'),
  'struct RPCESelectionCandidateResolver { let store: SelectionCatalog\n'
    + 'func removePathsDidCaptureExistingHook(_ state: StoredSelection) async {}\n'
    + ordinaryMethods + '\n' + candidateBody,
  adapter('SelectionPathMutationInput.swift'), adapter('SelectionPreparationInput.swift'), adapter('SelectionInputParsing.swift'),
  'enum SliceMutationMode { case add, set, remove, setPaths }',
  `enum EditFlowPerf { struct Dimensions { init(outcome: String) {} }
    enum Stage { enum ReadFile { static let folderResolutionGeneralLookupFallback = "folder"; enum AutoSelect { static let candidateResolutionTotal = "candidate"; static let structuralMerge = "merge" } } }
    static func begin(_ stage: String) -> String { stage }
    static func end(_ state: String, _ stage: String, _ dimensions: Dimensions) {}
    static func end(_ state: String, _ stage: String) {}
  }`,
  'extension SelectionCatalog {\n' + source(2, 21428, 21537) + '\n' + catalogFileLookup + '\n' + source(2, 21809, 21819)
    + '\n' + source(2, 21539, 21659) + '\n' + source(2, 21821, 21834).replaceAll('private func', 'func')
    + '\n' + source(2, 10708, 10714).replace('private func', 'func') + '\n}',
  `let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
var output: [[String: Any]] = []
for entry in raw {
    let input = entry["input"]!
    let fields = input as! [String: Any]
    var result: [String: Any]
    if fields["kind"] as! String == "parseSelectionInputs" {
        result = (try SelectionInputParsing(input)).render()
    } else if fields["kind"] as! String == "prepareSelection" {
        result = await (try SelectionPreparationInput(input)).render()
    } else if fields["kind"] as! String == "mutateSelectionPaths" {
        result = await (try SelectionPathMutationInput(input)).render()
    } else {
        result = await (try SelectionCandidatesInput(input)).render(); result.removeValue(forKey: "kind")
    }
    output.append(["name": entry["name"]!, "input": input, "expected": result])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))`,
].join('\n\n') + '\n';
const ordinaryDirectory = 'test/fixtures/rpce-selection-path-mutations/';
const preparationDirectory = 'test/fixtures/rpce-selection-preparation/';
const inputs = [...JSON.parse(readFileSync(directory + 'cases.json')), ...JSON.parse(readFileSync(ordinaryDirectory + 'cases.json')),
  ...JSON.parse(readFileSync(preparationDirectory + 'cases.json')), ...JSON.parse(readFileSync(parseDirectory + 'cases.json'))];
const output = JSON.parse(runReference(text, JSON.stringify(inputs)));
const candidates = output.filter(entry => entry.input.kind === 'resolveSelectionCandidates');
const ordinary = output.filter(entry => entry.input.kind === 'mutateSelectionPaths');
writeFileSync(directory + 'cases.json', JSON.stringify(candidates) + '\n');
writeFileSync(ordinaryDirectory + 'cases.json', JSON.stringify(ordinary) + '\n');
provenance.cases = candidates.length;
provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
const ordinaryProof = JSON.parse(readFileSync(ordinaryDirectory + 'provenance.json'));
ordinaryProof.sources = provenance.sources;
ordinaryProof.generator = provenance.generator;
ordinaryProof.cases = ordinary.length;
ordinaryProof.generatorSHA256 = provenance.generatorSHA256;
writeFileSync(ordinaryDirectory + 'provenance.json', JSON.stringify(ordinaryProof, null, 2) + '\n');
const preparations = output.filter(entry => entry.input.kind === 'prepareSelection');
writeFileSync(preparationDirectory + 'cases.json', JSON.stringify(preparations) + '\n');
const preparationProof = JSON.parse(readFileSync(preparationDirectory + 'provenance.json'));
preparationProof.sources = provenance.sources;
preparationProof.generator = provenance.generator;
preparationProof.generatorSHA256 = provenance.generatorSHA256;
preparationProof.cases = preparations.length;
writeFileSync(preparationDirectory + 'provenance.json', JSON.stringify(preparationProof, null, 2) + '\n');
const parsedInputs = output.filter(entry => entry.input.kind === 'parseSelectionInputs');
writeFileSync(parseDirectory + 'cases.json', JSON.stringify(parsedInputs) + '\n');
parseProof.cases = parsedInputs.length;
parseProof.generatorSHA256 = provenance.generatorSHA256;
writeFileSync(parseDirectory + 'provenance.json', JSON.stringify(parseProof, null, 2) + '\n');
console.log(JSON.stringify({ parsedInputs: parsedInputs.length, candidates: candidates.length, ordinaryMutations: ordinary.length,
  preparations: preparations.length }));
