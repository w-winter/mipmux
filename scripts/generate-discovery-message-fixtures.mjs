import { readReferenceSource, runReference } from './reference-harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-discovery-message-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision) {
  throw new Error('Reference revision differs.');
}
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(repo);
const directory = 'test/fixtures/rpce-discovery-message/';
const provenance = JSON.parse(readFileSync(directory + 'provenance.json'));
const source = entry => {
  const bytes = readReferenceSource(checkout, entry);
  return bytes.toString().split('\n').slice(entry.start - 1, entry.end).join('\n');
};
const message = source(provenance.sources[0]).replace('private func makeUserMessage(', 'func makeUserMessage(')
  .replace('ContextBuilderPromptStorage.shared.promptText', 'storage.promptText').replace('            print(metaPromptText)\n', '');
const prompts = source(provenance.sources[1]);
const text = `import Foundation
struct PromptText: Codable { let title: String; let content: String }
struct StoredPrompt { let id: UUID; let title: String; let content: String }
struct PromptStorage {
    let allPrompts: [StoredPrompt]
${prompts}
}
struct Reference {
    let storage: PromptStorage
${message}
}
struct Input: Codable {
    let kind: String; let tokenBudget: Int; let fileTree: String; let currentPrompt: String
    let discoveryInstructions: String; let contextBuilderPrompts: [PromptText]
}
struct Fixture: Codable { let name: String; let input: Input; let expected: String? }
struct Output: Codable { let name: String; let input: Input; let expected: String }
let cases = try JSONDecoder().decode([Fixture].self, from: FileHandle.standardInput.readDataToEndOfFile())
let output = cases.map { entry in
    let prompts = entry.input.contextBuilderPrompts.map { StoredPrompt(id: UUID(), title: $0.title, content: $0.content) }
    let renderer = Reference(storage: PromptStorage(allPrompts: prompts))
    let result = renderer.makeUserMessage(fileTree: entry.input.fileTree, userPrompt: entry.input.currentPrompt,
        discoverInstructions: entry.input.discoveryInstructions, adjustedBudget: entry.input.tokenBudget,
        contextBuilderPromptIDs: Set(prompts.map(\\.id)))
    return Output(name: entry.name, input: entry.input, expected: result)
}
let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
FileHandle.standardOutput.write(try encoder.encode(output))
`;
const referenceOutput = runReference(text, readFileSync(directory + 'cases.json'));
writeFileSync(directory + 'cases.json', referenceOutput.toString() + '\n');
provenance.generatorSHA256 = createHash('sha256').update(text).digest('hex');
writeFileSync(directory + 'provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ cases: JSON.parse(readFileSync(directory + 'cases.json')).length }));
