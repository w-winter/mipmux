import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-structure-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) throw new Error('Reference revision differs.');
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(repo);
const run = mkdtempSync(join(tmpdir(), 'smip-structure-reference-'));
try {
  const reference = resolve(checkout, 'Sources/RepoPrompt/Infrastructure') + '/';
  const provenance = JSON.parse(readFileSync('test/fixtures/rpce-structure/provenance.json'));
  for (const entry of provenance.sources) {
    const actual = createHash('sha256').update(readFileSync(resolve(checkout, entry.path))).digest('hex');
    if (actual !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  }
  const source=(path,start,end)=>readFileSync(reference+path,'utf8').split('\n').slice(start-1,end).join('\n');
  const native=name=>readFileSync('native/Sources/SmipBridge/'+name,'utf8');
  const wc='WorkspaceContext/',mcp='MCP/';
  // Immutable metadata bindings are shared; bounded traversal and explicit resolver bodies come from RPCE.
  const graphSource = readFileSync(reference + wc + 'WorkspaceCodemapSelectionGraph.swift', 'utf8');
  const sizeAccounting = source(wc + 'Models/WorkspaceCodemapSelectionGraphIncrementalModels.swift', 5, 12) +
   '\nenum RPCEGraphSizeAccounting {\n' +
   graphSource.slice(graphSource.indexOf('    private enum CandidateSizeOutcome {'), graphSource.indexOf('\n    private static func makeCandidate('))
   .replace('private enum', 'enum') + '\n' +
   graphSource.slice(graphSource.indexOf('    private static func fullSize('), graphSource.indexOf('    private static func snapshotNode('))
   .replace('private static func fullSize', 'static func fullSize').replaceAll('PersistentHashMap', 'Dictionary').replaceAll('PersistentHashSet', 'Set') +
   graphSource.slice(graphSource.indexOf('    private static func checkedAdd('), graphSource.indexOf('    private static func fileIDPrecedes(')) + '}';

  const storeSource = readFileSync(reference + wc + 'WorkspaceFileContextStore.swift', 'utf8');
  const boundedStart = storeSource.indexOf('    private func boundedDescendantFiles(');
  const boundedEnd = storeSource.indexOf('\n    }', boundedStart) + 6;
  const nativeCatalog = native('StructureSeedCatalog.swift');
  const localBounded = nativeCatalog.indexOf('    private func boundedDescendantFiles(');
  const catalogReference = nativeCatalog.slice(0, localBounded) + storeSource.slice(boundedStart, boundedEnd)
    .replaceAll('WorkspaceFileRecord', 'File') + '\n}';
  const explicitSource = source(mcp + 'ViewModels/MCPServerViewModel.swift', 5932, 5985);
  const bodyStart = explicitSource.indexOf('        precondition');
  let explicitBody = explicitSource.slice(bodyStart).replaceAll(/        #if DEBUG[\s\S]*?        #endif\n/g, '');
  explicitBody = explicitBody.replace(/        let directFiles = await[\s\S]*?\n        try Task.checkCancellation\(\)/,
    '        let directFiles = Dictionary(uniqueKeysWithValues: Set(paths).compactMap { selector in\n            catalog.lookupFile(selector).map { (selector, $0) }\n        })\n        try Task.checkCancellation()');
  explicitBody = explicitBody.replaceAll('[WorkspaceFileRecord]', '[StructureSeedCatalog.File]')
    .replace('await promptVM.workspaceFileContextStore.expandFolderInputToFiles(', 'catalog.expandFolderInputToFiles(')
    .replace('                rootScope: lookupRootScope,\n', '').replace('                profile: .mcpSelection,\n', '');
  const resolverText = native('RPCEStructureSeedResolver.swift');
  const methodStart = resolverText.indexOf('    private static func resolveFilesForCodeStructure(');
  const bodyLocal = resolverText.indexOf('        precondition', methodStart);
  const resolverReference = resolverText.slice(0, bodyLocal) + explicitBody + '\n}';
  let oracle=[catalogReference,resolverReference,native('StructureSnapshot.swift'),sizeAccounting,native('StructureAdjacency.swift'),native('StructureRootQueries.swift'),
   native('StructureInput.swift'),
   'enum TokenCalculationService {\n'+source(wc+'TokenAccounting/TokenCalculationService.swift',131,143)+'\n}',
   `struct BridgeFailure: Error { let code: String; init(_ code: String) { self.code = code } }`,
   source(wc+'Models/WorkspaceCodemapGraphStructureModels.swift',1,170).replace('case graphRevoked(WorkspaceCodemapGraphRevocationReason)','case graphRevoked'),
   source(wc+'Models/WorkspaceCodemapGraphPolicy.swift',1,170),
   source(wc+'Models/WorkspaceCodemapSelectionGraphModels.swift',11,25),
   source(wc+'WorkspaceCodemapGraphOrdering.swift',1,42).replace('import Darwin', '#if canImport(Darwin)\nimport Darwin\n#else\nimport Glibc\n#endif'),
   'struct RPCEGraphTraversal { let rootEpoch: WorkspaceCodemapRootEpoch; let graphPolicy = WorkspaceCodemapGraphPolicy.initial\n'+
   source(wc+'WorkspaceCodemapSelectionGraph.swift',599,873).replace('private func traverse(', 'func traverse(')+'\n'+
   source(wc+'WorkspaceCodemapSelectionGraph.swift',1752,1783).replaceAll('PersistentHashMap<UUID, WorkspaceCodemapGraphSnapshotNode>', '[UUID: WorkspaceCodemapGraphSnapshotNode]')+'\n}',
   'struct RPCEGraphMapping {\n'+source(wc+'WorkspaceFileContextStore.swift',14827,14898).replace('private func mapCodemapStructureRoot(','func mapCodemapStructureRoot(')+'\n'+
   source(wc+'WorkspaceFileContextStore.swift',14962,15002).replace('private func codemapRootEpochPrecedes(', 'func codemapRootEpochPrecedes(')+'\n}',
   'enum ToolResultDTOs {\n'+source(mcp+'ToolResultDTOs.swift',11,38)+'\n}\n'+source(mcp+'ToolResultDTOs.swift',305,476)+'\n}',
  ];
  let reply=source(mcp+'ViewModels/MCPServerViewModel.swift',6146,6361).replace('WorkspaceCodemapOperationPresentation?', 'StructureSignaturePresentation?');
  const a=reply.indexOf('        let pathByFileID ='),b=reply.indexOf('        var globalIssues',a);reply=reply.slice(0,a)+reply.slice(b);
  const c=reply.indexOf('        let signatureIssueCoverage:'),d=reply.indexOf('\n        var renderedFiles:',c);
  reply=reply.slice(0,c)+'        let signatureIssueCoverage = presentation?.coverage ?? CodeStructureSignatureIssueCoverage()\n        if let presentation { globalIssues.append(contentsOf: presentation.issues) }\n'+reply.slice(d);
  oracle.push('enum RPCEStructureReply {\n'+reply+'\n'+source(mcp+'ViewModels/MCPServerViewModel.swift',6363,6380).replace('private static func codeStructureUnavailableReply(', 'static func codeStructureUnavailableReply(')+'\n'+source(mcp+'ViewModels/MCPServerViewModel.swift',6382,6396)+'\n'+source(mcp+'ViewModels/MCPServerViewModel.swift',6476,6506)+'\n'+source(mcp+'ViewModels/MCPServerViewModel.swift',6522,6529)+'\n}');
  let formatter=source(mcp+'ToolOutputFormatter.swift',3055,3428).replace(/^    static func formatCodeStructure[\s\S]*?\n        let allIssues/, '    static func formatCodeStructure(dto: ToolResultDTOs.CodeStructureReplyDTO) -> String {\n        let allIssues').replaceAll('return [.text(out.joined(separator: "\\n"))]', 'return out.joined(separator: "\\n")');
  oracle.push('enum RPCEStructureFormatter {\n'+formatter+'\n'+source(mcp+'ToolOutputFormatter.swift',81,85)+'\n}');
  oracle.push(`let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]\nlet result = try raw.map { item -> [String: Any] in\n let input = try StructureInput(item["input"]!); return ["name": item["name"]!, "input": item["input"]!, "expected": try input.render()]\n}\nFileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]))`);
  const text = oracle.join('\n\n') + '\n';
  writeFileSync(run + '/reference.swift', text);
  const cases = JSON.parse(readFileSync('test/fixtures/rpce-structure/cases.json')).map(({name, input}) => ({name, input}));
  execFileSync('swiftc', [run + '/reference.swift', '-o', run + '/reference'], { stdio: 'inherit' });
  writeFileSync(run + '/input.json', JSON.stringify(cases));
  const inputFile = openSync(run + '/input.json', 'r'), outputFile = openSync(run + '/output.json', 'w');
  try { execFileSync(run + '/reference', [], { stdio: [inputFile, outputFile, 'inherit'] }); }
  finally { closeSync(inputFile); closeSync(outputFile); }
  const output = readFileSync(run + '/output.json');
  writeFileSync('test/fixtures/rpce-structure/cases.json', JSON.stringify(JSON.parse(output)) + '\n');
  provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
  provenance.generatorScript = 'scripts/generate-structure-fixtures.mjs';
  provenance.command = 'node scripts/generate-structure-fixtures.mjs <RPCE-checkout-at-' + revision + '>';
  delete provenance.generationEvidence;
  writeFileSync('test/fixtures/rpce-structure/provenance.json', JSON.stringify(provenance, null, 2) + '\n');
  console.log(JSON.stringify({cases: cases.length}));
} finally { execFileSync('trash', [run]); }
