import { runReference } from './reference-harness.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-prompt-assembly-fixtures.mjs <pinned-rpce-checkout>');
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
const path = 'Sources/RepoPromptDomainRuntime/ProviderContent/PromptAssemblyBuilder.swift';
const source = execFileSync('git', ['-C', checkout, 'show', revision + ':' + path]);
const hash = value => createHash('sha256').update(value).digest('hex');
const harness = `
@main struct Main {
    static func main() throws {
        let raw = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [[String: Any]]
        let output = raw.map { fixture -> [String: Any] in
            let input = fixture["input"] as! [String: Any]
            var snippets: [PromptSection: String] = [:]
            for (name, value) in input["snippets"] as! [String: Any] {
                if let text = value as? String { snippets[PromptSection(rawValue: name)!] = text }
            }
            let order = (input["order"] as! [String]).map { PromptSection(rawValue: $0)! }
            let disabled = Set((input["disabled"] as! [String]).map { PromptSection(rawValue: $0)! })
            return ["name": fixture["name"]!, "input": input, "expected": ["kind": "promptAssembly", "text":
                PromptAssemblyBuilder.build(order: order, disabled: disabled,
                    duplicateUserInstructionsAtTop: input["duplicateUserInstructionsAtTop"] as! Bool, snippets: snippets)]]
        }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
    }
}
`;
const order = ['fileMap', 'fileContents', 'gitDiff', 'metaPrompts', 'userInstructions'];
const snippets = { fileMap: '<file_map>\nmap\n</file_map>\n\n', fileContents: '<file_contents>\nfiles\n</file_contents>\n\n',
  gitDiff: '<git_diff>\npatch\n</git_diff>\n\n', metaPrompts: '<meta prompt 1 = "Review">\nrole\n</meta prompt 1>\n\n',
  userInstructions: '<user_instructions>\ntask\n</user_instructions>\n\n' };
const fixture = (name, changes = {}) => ({ name, input: { kind: 'renderPromptAssembly', order, disabled: [],
  duplicateUserInstructionsAtTop: false, snippets, ...changes } });
const cases = [
  fixture('source-section-order'),
  fixture('caller-section-order', { order: [...order].reverse() }),
  fixture('empty-and-missing-snippets', { snippets: { fileMap: '', fileContents: null, gitDiff: null,
    metaPrompts: '', userInstructions: '😀\0λ' } }),
  fixture('newline-boundaries', { snippets: { fileMap: 'map', fileContents: 'files\n', gitDiff: 'patch\r\n',
    metaPrompts: ' \n', userInstructions: 'task\n\n' } }),
  fixture('disabled-sections', { disabled: ['fileMap', 'gitDiff', 'metaPrompts'] }),
  fixture('duplicate-user-instructions', { duplicateUserInstructionsAtTop: true }),
  fixture('disabled-user-still-duplicated-at-top', { disabled: ['userInstructions'], duplicateUserInstructionsAtTop: true }),
  fixture('duplicate-section-order', { order: ['userInstructions', 'fileMap', 'userInstructions'] }),
  fixture('empty-order', { order: [], duplicateUserInstructionsAtTop: true }),
];
const output = runReference(source.toString() + harness, JSON.stringify(cases), ['-parse-as-library', '-package-name', 'SmipReference']);
const directory = 'test/fixtures/rpce-prompt-assembly/';
mkdirSync(directory, { recursive: true });
writeFileSync(directory + 'cases.json', JSON.stringify(JSON.parse(output), null, 2) + '\n');
writeFileSync(directory + 'provenance.json', JSON.stringify({ revision, sources: [{ path, sha256: hash(source) }],
  cases: cases.length, generatorSHA256: hash(source.toString() + harness),
  bindings: ['The complete original PromptAssemblyBuilder executes independently. Inputs are already formatted snippets; file-block generation, final-map construction, presets and Git resolution are not covered.'] }, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length }));
