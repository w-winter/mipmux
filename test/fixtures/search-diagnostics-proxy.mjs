import { spawn } from 'node:child_process';

// Only expected native boundary outcomes are scripted; workspace admission and MCP dispatch remain real.
const child = spawn(process.env.MIPMUX_NATIVE, process.argv.slice(2), { stdio: 'pipe', env: process.env });
const requests = new Map();
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
function scanResult(result, op) {
  if (op.pattern === 'fixture-path-failure') return { kind: 'regexSearch', matchingLines: 1, matches: [1] };
  if (op.pattern === 'fixture-per-file' && op.text === 'hello\n') return { kind: 'regexSearchError', diagnostic: diagnostic('file') };
  return result;
}
function fixtureFrame(frame, op) {
  if (frame.kind !== 'terminal' || !op?.pattern?.includes('fixture-')) return frame;
  switch (op.kind) {
    case 'matchSearchPaths': return { ...frame, result: pathResult(frame.result, op) };
    case 'compileRegexContent': return compileFrame(frame, op);
    case 'scanRegexContent': return { ...frame, result: scanResult(frame.result, op) };
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
