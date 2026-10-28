import { spawn } from 'node:child_process';

// Only expected native boundary outcomes are scripted; workspace admission and MCP dispatch remain real.
const child = spawn(process.env.MIPMUX_NATIVE, process.argv.slice(2), { stdio: 'pipe', env: process.env });
const requests = new Map();
// The number of scan outcomes already forwarded for each scan request, which identifies the next one's file.
const scanned = new Map();
const diagnostic = phase => ({ kind: 'pattern', issue: phase + ' fixture issue', suggestion: phase + ' fixture suggestion' });
function pathResult(result, op) {
  const fail = ['fixture-path-failure', 'fixture-both-failure', 'fixture-content-zero', 'fixture-both-recovery\\.fail'].includes(op.pattern);
  if (fail) return { kind: 'searchPathsError', order: result.order, excluded: result.excluded, diagnostic: diagnostic('path') };
  if (op.pattern === 'fixture-content-failure') return { ...result, matches: result.order };
  return result;
}
function compileFrame(frame, op) {
  if (op.pattern === 'fixture-recovery\\.fail') {
    return { ...frame, result: { kind: 'regexCompilation', correction: { kind: 'corrected', warning: 'The content-search pattern was auto-corrected before running. Results may reflect a repaired or escaped version of the requested regex rather than the exact pattern you entered.' } } };
  }
  if (['\\Qfixture-recovery.fail\\E', '\\Qfixture-both-recovery.fail\\E'].includes(op.pattern)) {
    return { ...frame, result: { kind: 'regexSearchError', diagnostic: diagnostic('content') } };
  }
  if (['fixture-content-failure', 'fixture-both-failure', 'fixture-path-zero'].includes(op.pattern)) {
    return { ...frame, result: { kind: 'regexSearchError', diagnostic: diagnostic('content') } };
  }
  if (op.pattern === 'fixture-native-failure' || op.pattern === 'fixture-authorization-failure') {
    return { ...frame, result: { kind: 'failure', code: op.pattern === 'fixture-native-failure' ? 'nativeOperationFailed' : 'invalidSourceCapability', errno: null } };
  }
  if (op.pattern === 'fixture-protocol-failure') return { ...frame, result: { kind: 'regexCompilation', correction: { kind: 'PRIVATE_DETAIL' } } };
  return frame;
}
// Fixture file text, which a scripted match returns as the native scan does for matched files.
const fixtureText = { 'example.txt': 'hello\n' };
function scanOutcome(outcome, file, op) {
  if (outcome.kind !== 'decoded') return outcome;
  if (op.pattern === 'fixture-path-failure') {
    return { ...outcome, result: { kind: 'regexSearch', matchingLines: 1, matches: [1] }, text: fixtureText[file.path] };
  }
  if (op.pattern === 'fixture-tampered-text' && file.path === 'example.txt') {
    // Text that differs from the file while keeping its line count and claimed identity.
    return { ...outcome, result: { kind: 'regexSearch', matchingLines: 1, matches: [1] }, text: 'jello\n' };
  }
  if (op.pattern === 'fixture-per-file' && file.path === 'example.txt') {
    return { ...outcome, result: { kind: 'regexSearchError', diagnostic: diagnostic('file') }, text: null };
  }
  return outcome;
}
function fixtureFrame(frame, op) {
  if (!op?.pattern?.includes('fixture-')) return frame;
  if (frame.kind === 'scanOutcome') {
    const index = scanned.get(frame.requestId) ?? 0;
    scanned.set(frame.requestId, index + 1);
    return { ...frame, outcome: scanOutcome(frame.outcome, op.files[index], op) };
  }
  if (frame.kind !== 'terminal') return frame;
  switch (op.kind) {
    case 'matchSearchPaths': return { ...frame, result: pathResult(frame.result, op) };
    case 'compileRegexContent': return compileFrame(frame, op);
    default: return frame;
  }
}
let input = '', output = '';
process.stdin.on('data', bytes => {
  input += bytes.toString();
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const request = JSON.parse(line); requests.set(request.requestId, request.operation);
    child.stdin.write(line + '\n');
  }
});
child.stdout.on('data', bytes => {
  output += bytes.toString();
  let newline;
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    const frame = JSON.parse(line), op = requests.get(frame.requestId);
    process.stdout.write(JSON.stringify(fixtureFrame(frame, op)) + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
child.stderr.pipe(process.stderr);
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('close', code => process.exit(code ?? 1));
