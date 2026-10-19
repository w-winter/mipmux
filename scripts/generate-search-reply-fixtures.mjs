import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [checkout] = process.argv.slice(2);
if (!checkout) throw new Error('Usage: node scripts/generate-search-reply-fixtures.mjs <rpce-checkout>');
process.chdir(resolve(fileURLToPath(new URL('..', import.meta.url))));
const directory = 'test/fixtures/rpce-search-response-cap/';
const metadata = JSON.parse(readFileSync(directory + 'provenance.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const original = execFileSync('git', ['-C', checkout, 'show', `${metadata.revision}:${metadata.path}`], { encoding: 'utf8' });
if (hash(original) !== metadata.sourceSHA256) throw new Error('Pinned source identity differs');
const excerpt = original.split('\n').slice(metadata.startLine - 1, metadata.endLine).join('\n');
if (hash(excerpt) !== metadata.excerptSHA256) throw new Error('Source range differs');
const totals = original.split('\n').slice(metadata.totalsRange[0] - 1, metadata.totalsRange[1]).join('\n');
if (hash(totals) !== metadata.totalsExcerptSHA256) throw new Error('Source totals range differs');
const cases = JSON.parse(readFileSync(directory + 'cases.json'));
const source = `import Foundation
enum ToolResultDTOs { struct PerFileCount { let path: String; let count: Int } }
struct SearchMatch: Decodable { let filePath: String; let lineNumber: Int; let lineText: String }
struct Input: Decodable { let name: String; let matches: [SearchMatch]; let paths: [String]; let maxResults: Int }
func project(_ input: Input) throws -> [String: Any] {
    let contentMatchesFull = input.matches, pathMatchesFull = input.paths, maxResults = input.maxResults
    var dtoBuildLimitHit = false, dtoBuildOutcome = "completed"
${excerpt}
${totals}
    return ["name": input.name, "includedLines": includedContentMatches.map { $0.lineNumber + 1 }, "includedPaths": includedPathLines,
        "omittedContent": omittedContent, "omittedPaths": omittedPaths, "sizeLimitHit": sizeLimitHit,
        "limitHit": dtoBuildLimitHit, "outcome": dtoBuildOutcome, "usedCharacters": usedChars,
        "perFileTotals": perFileTotalsDTO.map { ["path": $0.path, "count": $0.count] as [String: Any] }]
}
@main struct Driver {
    static func main() throws {
        let input = try JSONDecoder().decode([Input].self, from: FileHandle.standardInput.readDataToEndOfFile())
        let bytes = try JSONSerialization.data(withJSONObject: input.map { try project($0) }, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes)
    }
}
`;
const scratch = mkdtempSync(join(tmpdir(), 'smip-search-reply-source-'));
try {
  writeFileSync(join(scratch, 'reference.swift'), source);
  execFileSync('swiftc', ['-parse-as-library', '-module-cache-path', join(scratch, 'cache'),
    join(scratch, 'reference.swift'), '-o', join(scratch, 'reference')], { stdio: 'inherit' });
  const results = JSON.parse(execFileSync(join(scratch, 'reference'), [], { input: JSON.stringify(cases) }));
  writeFileSync(directory + 'cases.json', JSON.stringify(cases.map((value, index) => ({ ...value, expected: results[index] })), null, 2) + '\n');
  writeFileSync(directory + 'provenance.json', JSON.stringify({ revision: metadata.revision, path: metadata.path,
    sourceSHA256: metadata.sourceSHA256, gitBlob: metadata.gitBlob, startLine: metadata.startLine, endLine: metadata.endLine,
    excerptSHA256: metadata.excerptSHA256, excerpt, totalsRange: metadata.totalsRange, totalsExcerpt: totals,
    totalsExcerptSHA256: metadata.totalsExcerptSHA256, cases: cases.length, referenceSHA256: hash(source),
    generator: 'scripts/generate-search-reply-fixtures.mjs', generatorSHA256: hash(readFileSync(fileURLToPath(import.meta.url))) }, null, 2) + '\n');
  console.log(JSON.stringify({ cases: cases.length, sourceRange: [metadata.startLine, metadata.endLine] }));
} finally { execFileSync('/usr/bin/trash', [scratch]); }
