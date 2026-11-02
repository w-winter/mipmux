import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const revision = '43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3';
if (!process.env.RPCE_REFERENCE_ROOT) throw new Error(`Set RPCE_REFERENCE_ROOT to a RepoPrompt CE clone that contains commit ${revision}.`);
const reference = resolve(process.env.RPCE_REFERENCE_ROOT);
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = [];
function original(path, ranges) {
  const bytes = execFileSync('git', ['show', revision + ':' + path], { cwd: reference });
  const lines = bytes.toString().split('\n');
  const excerpts = ranges.map(([start, end]) => ({ start, end, text: lines.slice(start - 1, end).join('\n') + '\n' }));
  sources.push({ path, sha256: hash(bytes), blob: execFileSync('git', ['rev-parse', revision + ':' + path],
    { cwd: reference, encoding: 'utf8' }).trim(), ranges: excerpts.map(({ start, end, text }) => ({ start, end, sha256: hash(text) })) });
  return excerpts.map(excerpt => excerpt.text).join('\n');
}
const actor = original('Sources/RepoPrompt/Features/Search/SearchMatch.swift', [[3072, 3159], [3172, 3177]]);
const toolkit = original('Sources/RepoPromptRegexCore/RegexToolkit.swift', [[378, 438]]);
const literal = original('Sources/RepoPromptRegexCore/SwiftPCRE2/PCRE2LiteralEscaping.swift', [[1, 14]]);
const escape = original('Sources/RepoPromptRegexCore/PCRE2RegexAdapter.swift', [[137, 139]]);
const boundary = original('Sources/RepoPromptRegexCore/PCRE2RegexAdapter.swift', [[301, 301]]);
const provider = original('Sources/RepoPrompt/Infrastructure/MCP/WindowTools/MCPFileToolProvider.swift', [[711, 717]]);
const emptyMessage = provider.match(/MCPError\.invalidParams\("([^"]+)"\)/)[1];
const inputs = [
  ...['needle', ' \n^anchor$\u0085', 'func()', '(foo|bar)', 'foo|bar', '|foo', 'foo|', ' | ', '\\bword', '\\w+',
    '\\n', '^$', 'a.*b', 'a.+b', '[ab]', '][', 'a{2,3}', 'a{,}', 'a{٢}', 'a{no}', '^word', 'word$',
    '(?i:word)', '(?-i:word)', '(?J:word)', '(?i-:word)', 'a+b', 'one  two', 'let foo.bar', '\u0085 \r\n', '\u200B', 'x\0y']
    .map((text, index) => ({ name: 'inferred-' + index, input: { kind: 'prepareSearchPattern', text, queryKind: 'auto' } })),
  { name: 'explicit-literal-regex-looking', input: { kind: 'prepareSearchPattern', text: ' ^anchor$ ', queryKind: 'literal' } },
  { name: 'literal-quote-terminator', input: { kind: 'prepareSearchPattern', text: 'end\\E value', queryKind: 'literal' } },
  { name: 'explicit-regex-space', input: { kind: 'prepareSearchPattern', text: ' one two ', queryKind: 'regex' } },
];
for (const item of inputs) { item.input.wholeWord = false; item.input.mode = 'content'; }
inputs.push({ name: 'fuzzy-space-ignores-whole-word', input: {
  kind: 'prepareSearchPattern', text: 'one two', queryKind: 'literal', wholeWord: true, mode: 'content',
} });
for (const [name, text, queryKind] of [
  ['literal-punctuation', '++', 'literal'], ['regex-alternation', 'left|right', 'regex'],
  ['regex-grouped-alternation', '(?:left|right)', 'regex'], ['literal-identifier', 'left', 'literal'],
  ['literal-unicode', 'café', 'literal'], ['literal-dot', 'a.b', 'literal'],
  ['regex-space', 'one two', 'regex'],
]) inputs.push({ name: 'whole-word-' + name, input: { kind: 'prepareSearchPattern', text, queryKind,
  wholeWord: true, mode: 'content' } });
const driver = `
struct Input: Decodable { let text: String; let queryKind: String; let wholeWord: Bool }
struct Case: Decodable { let name: String; let input: Input }
let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let outputs = cases.map { item -> [String: Any] in
    let pattern = item.input.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if pattern.isEmpty { return ["kind": "searchPatternError", "message": ${JSON.stringify(emptyMessage)}] }
    let isRegex = item.input.queryKind == "auto" ? FileSearchActor.containsRegexSyntax(pattern) : item.input.queryKind == "regex"
    return ["kind": "searchPattern", "mode": "content", "path": ["text": pattern, "isRegex": isRegex],
            "content": FileSearchActor.contentPattern(pattern, isRegex: isRegex, wholeWord: item.input.wholeWord)]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outputs, options: [.sortedKeys]))
`;
const source = 'import Foundation\n' + literal + '\nenum RegexToolkit {\n' + toolkit + '\n}\nenum RepoPromptPCRE2Adapter {\n' +
  escape + '\n}\nenum FileSearchActor {\n' + actor + `
    static func wordPattern(_ candidate: String, wholeWord: Bool) -> String {
${boundary}
        return effective
    }
    static func contentPattern(_ pattern: String, isRegex: Bool, wholeWord: Bool) -> [String: Any] {
        let fuzzy = !isRegex && pattern.contains(" ")
        if fuzzy { return ["text": convertSpacesToFuzzyRegex(pattern), "isRegex": true] }
        let candidate = isRegex ? pattern : RepoPromptPCRE2Adapter.escapedLiteral(pattern)
        return ["text": wholeWord ? wordPattern(candidate, wholeWord: true) : pattern,
                "isRegex": isRegex || wholeWord]
    }
}\n` + driver;
const scratch = mkdtempSync(join(tmpdir(), 'rpce-search-pattern-'));
let outputs;
try {
  writeFileSync(join(scratch, 'original.swift'), source); writeFileSync(join(scratch, 'inputs.json'), JSON.stringify(inputs));
  execFileSync('swiftc', ['-package-name', 'SearchReference', '-module-cache-path', join(scratch, 'cache'),
    join(scratch, 'original.swift'), '-o', join(scratch, 'oracle')]);
  outputs = JSON.parse(execFileSync(join(scratch, 'oracle'), [join(scratch, 'inputs.json')], { encoding: 'utf8' }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
const cases = inputs.map((item, index) => ({ ...item, expected: outputs[index] }));
const files = { 'cases.json': cases, 'provenance.json': { revision, sources, cases: cases.length,
  generatorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))), combinedSourceSHA256: hash(source),
  bindings: ['Original regex detection, PCRE feature detection, literal escaping and flexible-space conversion execute verbatim. The original whole-word pattern expression executes in a minimal function without the enclosing compiler/repair routine.',
    'The driver applies MCP trim/empty/inferred-regex rules and chooses fuzzy conversion only for non-regex patterns with spaces. The source literal fuzzy branch bypasses whole-word handling; path matching ignores whole-word.',
    'This proves pattern preparation, not auto-mode routing, matching engines, regex repair, path globbing, filters or result limits.'] } };
for (const [name, content] of Object.entries(files)) {
  const bytes = JSON.stringify(content, null, 2) + '\n';
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(directory, name), 'utf8'), bytes, name);
  else writeFileSync(join(directory, name), bytes);
}
console.log(JSON.stringify({ cases: cases.length, byteIdentical: process.argv.includes('--check') }));
