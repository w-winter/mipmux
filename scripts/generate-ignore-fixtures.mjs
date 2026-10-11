import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-ignore-fixtures.mjs <pinned-rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-ignore/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== provenance.sourceRevision) throw new Error('Reference revision differs.');
const sources = provenance.sources.map(entry => {
  const bytes = readFileSync(resolve(checkout, entry.path));
  if (hash(bytes) !== entry.sha256) throw new Error('Modified reference source: ' + entry.path);
  return bytes.toString();
});
const lines = (source, start, end) => sources[source].split('\n').slice(start - 1, end).join('\n');
const scratch = mkdtempSync(join(tmpdir(), 'smip-ignore-reference-'));
mkdirSync(scratch + '/include');
writeFileSync(scratch + '/include/wildmatch.h', sources[5]);
writeFileSync(scratch + '/include/repo_gitignore.h', sources[6]);
writeFileSync(scratch + '/include/module.modulemap', 'module RepoPromptC { header "wildmatch.h" header "repo_gitignore.h" export * }\n');
for (const [index, name] of [[7, 'wildmatch'], [8, 'wrapper']]) {
  writeFileSync(scratch + '/' + name + '.c', sources[index]);
  execFileSync('clang', ['-I', scratch + '/include', '-c', scratch + '/' + name + '.c', '-o', scratch + '/' + name + '.o']);
}
const text = `import Foundation
${sources[0].replaceAll('package ', '').replaceAll('public ', '')}
${sources[1].replaceAll('package ', '').replace('import RepoPromptFoundation\n', '')}
${sources[2].replaceAll('package ', '')}
${lines(3, 18, 29).replaceAll('package ', '')}
enum RootAuthority {
${lines(4, 24, 29).replaceAll('package ', '')}
${lines(4, 328, 340).replaceAll('package ', '')}
${lines(4, 346, 364).replaceAll('package ', '')}
}
struct Policy: Codable { let kind: String; let prefix: String? }
struct Controls: Codable { let gitignore: String?; let global: String; let repoIgnore: String?; let cursorignore: String?; let respectRepoIgnore: Bool; let respectCursorignore: Bool }
struct Layer: Codable { let content: String; let directory: String; let authority: String }
struct Query: Codable { let path: String; let isDirectory: Bool }
struct Input: Codable { let policy: Policy; let controls: Controls; let layers: [Layer]; let queries: [Query] }
struct Fixture: Codable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
var output: [[String: Any]] = []
for entry in cases {
    let policy: IgnoreRulePolicy = entry.input.policy.kind == "git" ? .gitRoot(repositoryRelativeRootPrefix: IgnoreRootPrefix(value: entry.input.policy.prefix!)) : .nonGitRoot
    let c = entry.input.controls
    let authority = RootAuthority.compileRootAuthority(gitignoreContent: c.gitignore, globalIgnoreContent: c.global, repoIgnoreContent: c.repoIgnore, cursorignoreContent: c.cursorignore)
    let rules = RootAuthority.makeRootRules(authority: authority, respectRepoIgnore: c.respectRepoIgnore, respectCursorignore: c.respectCursorignore, policy: policy)
    for layer in entry.input.layers {
        rules.addCompiledLayer(GitignoreCompiler.compile(content: layer.content, directoryPath: layer.directory),
            authority: layer.authority == "mandatoryGit" ? .mandatoryGit : .secondary)
    }
    let snapshot = rules.snapshot()
    let results = entry.input.queries.map { query -> [String: Any] in
        let outcome = snapshot.matchOutcome(relativePathComponents: query.path.split(separator: "/"), isDirectory: query.isDirectory)
        let match: String
        switch outcome { case .ignore: match = "ignore"; case .allow: match = "allow"; case .noMatch, nil: match = "none" }
        return ["path": query.path, "isDirectory": query.isDirectory,
            "ignored": snapshot.isIgnored(relativePath: query.path, isDirectory: query.isDirectory),
            "match": match, "requiresTraversal": snapshot.requiresTraversal(for: query.path)]
    }
    let d = snapshot.traversalDiagnostics
    output.append(["name": entry.name, "result": ["kind": "ignoreRules", "paths": results,
        "hasNegative": snapshot.hasAnyNegativePatterns(),
        "traversal": ["exactPrefixCount": d.exactPrefixCount, "patternHintCount": d.patternHintCount,
            "broadPatternHintCount": d.broadPatternHintCount, "basenameOnlyNegationCount": d.basenameOnlyNegationCount]]])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
`;
writeFileSync(scratch + '/reference.swift', text);
execFileSync('swiftc', ['-I', scratch + '/include', scratch + '/reference.swift', scratch + '/wildmatch.o', scratch + '/wrapper.o', '-o', scratch + '/reference'], { stdio: 'inherit' });
const input = openSync(directory + 'cases.json', 'r'), output = openSync(scratch + '/output.json', 'w');
try { execFileSync(scratch + '/reference', [], { stdio: [input, output, 'inherit'] }); }
finally { closeSync(input); closeSync(output); }
const inputs = JSON.parse(readFileSync(directory + 'cases.json')), results = JSON.parse(readFileSync(scratch + '/output.json'));
writeFileSync(directory + 'cases.json', JSON.stringify(results.map((entry, index) => ({ ...inputs[index], expected: entry.result })), null, 2) + '\n');
provenance.cases = results.length; provenance.generatorSHA256 = hash(text);
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, scratch }));
