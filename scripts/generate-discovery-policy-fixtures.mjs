import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReferenceSource, runReference } from './reference-harness.mjs';
import { bindReferenceDiscoveryPolicy } from './reference-discovery-bindings.mjs';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-discovery-policy-fixtures.mjs <pinned-rpce-checkout>');
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const prior = JSON.parse(readFileSync(resolve(repo, 'test/fixtures/rpce-discovery/provenance.json')));
assert.equal(execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), prior.revision);
const lines = readReferenceSource(checkout, { path: prior.source, sha256: prior.sourceSHA256 }).toString('utf8').split('\n');
let factory = lines.slice(6, 607).join('\n');
const diagnostic = /^\s*print\("\[SystemPromptService\] Review mode activated[^\n]*\)\n/gm;
assert.equal([...factory.matchAll(diagnostic)].length, 1);
factory = factory.replace(diagnostic, '\n');
const helper = lines.slice(1090, 1137).join('\n');
const timeout = lines.slice(1276, 1287).join('\n');
const program = `import Foundation
struct Language: Hashable, Comparable {
 let displayName: String
 static func < (left: Language, right: Language) -> Bool { left.displayName < right.displayName }
}
struct SyntaxManager {
 static let shared = SyntaxManager()
 let extensionToLanguage = ["fixture": Language(displayName: "__SUPPORTED_LANGUAGES__")]
}
enum AgentProviderKind { case codexExec; case generic }
enum PromptEnhancementMode: String, Codable { case fullRewrite; case augment; case preserve }
enum ContextBuilderDefaults { static let questionTimeoutSeconds: TimeInterval = 300 }
${factory}
${helper}
}
${timeout}
struct Input: Codable {
 let tokenBudget: Int; let enhancementMode: PromptEnhancementMode; let allowClarifyingQuestions: Bool
 let responseType: String; let instructions: String?; let questionTimeoutSeconds: Int
 let restrictsReviewGitToExplicitReadOnly: Bool; let reviewRootNames: [String]
}
struct Case: Codable { let name: String; let input: Input }
struct Output: Codable { let name: String; let input: Input; let expected: String }
let cases = try JSONDecoder().decode([Case].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = cases.map { entry in
 let input = entry.input
 return Output(name: entry.name, input: input, expected: SystemPromptService.discoverPrompt(
  tokenBudget: input.tokenBudget, agentKind: .codexExec, enhancementMode: input.enhancementMode,
  allowClarifyingQuestions: input.allowClarifyingQuestions, responseType: input.responseType,
  instructions: input.instructions, questionTimeoutSeconds: TimeInterval(input.questionTimeoutSeconds),
  restrictsReviewGitToExplicitReadOnly: input.restrictsReviewGitToExplicitReadOnly, reviewRootNames: input.reviewRootNames))
}
let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
FileHandle.standardOutput.write(try encoder.encode(output))
`;
const inputs = [];
for (const mode of ['fullRewrite', 'augment', 'preserve']) for (const questions of [false, true]) {
  for (const review of ['none', 'elected', 'readOnlyNamed', 'readOnlyLookup']) {
    inputs.push({ name: mode + '-' + (questions ? 'interactive' : 'noninteractive') + '-' + review,
      input: { tokenBudget: 198500, enhancementMode: mode, allowClarifyingQuestions: questions,
        responseType: review === 'none' ? 'clarify' : 'review', instructions: null, questionTimeoutSeconds: 300,
        restrictsReviewGitToExplicitReadOnly: review.startsWith('readOnly'),
        reviewRootNames: review === 'readOnlyNamed' ? ['smip', 'repoprompt-ce'] : [] } });
  }
}
const originals = JSON.parse(runReference(program, Buffer.from(JSON.stringify(inputs))).toString());
assert.equal(originals.length, inputs.length);
const identity = text => ({ sha256: createHash('sha256').update(text).digest('hex'), byteCount: Buffer.byteLength(text) });
for (const mode of ['fullRewrite', 'augment', 'preserve']) {
  assert.equal(originals.find(entry => entry.name === mode + '-noninteractive-elected').expected,
    readFileSync(resolve(repo, 'test/fixtures/rpce-discovery/' + mode + '.md'), 'utf8'));
}
const cases = originals.map(entry => ({ name: entry.name, input: entry.input,
  originalIdentity: identity(entry.expected), expected: bindReferenceDiscoveryPolicy(entry.expected, entry.input) }));
const directory = resolve(repo, 'test/fixtures/smip-discovery-policy');
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
writeFileSync(resolve(directory, 'provenance.json'), JSON.stringify({
  sourceRevision: prior.revision, source: prior.source, sourceSHA256: prior.sourceSHA256,
  sourceRanges: [[7, 607], [1091, 1137], [1277, 1287]],
  generator: 'scripts/generate-discovery-policy-fixtures.mjs',
  generatorIdentity: identity(readFileSync(fileURLToPath(import.meta.url))),
  bindings: 'scripts/reference-discovery-bindings.mjs',
  bindingsIdentity: identity(readFileSync(fileURLToPath(new URL('./reference-discovery-bindings.mjs', import.meta.url)))),
  generatedHarnessIdentity: identity(program), catalog: '__SUPPORTED_LANGUAGES__', caseCount: cases.length,
  changes: ['Stub external types and language catalog', 'Remove the single diagnostic stdout print',
    'Apply checked test-only smip tool/runtime bindings; production composer and template are not imported'],
}, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, directory, originalModesMatched: 3 }));
