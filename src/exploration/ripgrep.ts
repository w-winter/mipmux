import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import { WorkspaceFailure } from '../workspace/values.js';

const encoded = Type.Union([Type.Object({ text: Type.String() }), Type.Object({ bytes: Type.String() })]);
const match = Type.Object({ type: Type.Literal('match'), data: Type.Object({ path: encoded, lines: encoded,
  line_number: Type.Integer({ minimum: 1 }), absolute_offset: Type.Integer({ minimum: 0 }),
  submatches: Type.Array(Type.Object({ match: encoded, start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) })) }) });
const matchValidator = Compile(match);
const otherValidator = Compile(Type.Object({ type: Type.Union([Type.Literal('begin'), Type.Literal('end')]), data: Type.Object({}) }));
const summaryValidator = Compile(Type.Object({ type: Type.Literal('summary'), data: Type.Object({ stats: Type.Object({
  matches: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), matched_lines: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}) }) }));
export type RipgrepMatch = Static<typeof match>['data'];
export function encodedText(value: Static<typeof encoded>): string {
  if ('text' in value) return value.text;
  const bytes = Buffer.from(value.bytes, 'base64');
  if (bytes.toString('base64') !== value.bytes) throw new WorkspaceFailure('searchProtocolError');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new WorkspaceFailure('searchProtocolError'); }
}

export async function runRipgrep(supervisor: ProcessSupervisor, executable: string, args: readonly string[],
  cwd: string, input: string, signal: AbortSignal, onMatch: (match: RipgrepMatch) => void | Promise<void>, preflight = false): Promise<void> {
  signal.throwIfAborted();
  const owned = supervisor.spawn({ executable, args, env: { LC_ALL: 'C.UTF-8' }, cwd });
  let pending = Buffer.alloc(0), failure: unknown = null, stderr = false;
  let summarySeen = false, occurrences = 0, matchingLines = 0;
  const abort = () => { void owned.stop(); };
  signal.addEventListener('abort', abort, { once: true });
  owned.child.stderr.on('data', () => { stderr = true; });
  owned.child.stdin.on('error', error => { failure = error; void owned.stop(); });
  try {
    if (input.length) owned.child.stdin.end(input);
    else owned.child.stdin.end();
    for await (const chunk of owned.child.stdout) {
      const bytes: unknown = chunk;
      if (!(bytes instanceof Buffer)) throw new WorkspaceFailure('searchProtocolError');
      if (preflight) continue;
      pending = Buffer.concat([pending, bytes]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { throw new WorkspaceFailure('searchProtocolError'); }
        if (summarySeen) throw new WorkspaceFailure('searchProtocolError');
        if (matchValidator.Check(value)) {
          occurrences += value.data.submatches.length; matchingLines++;
          await onMatch(value.data);
        } else if (summaryValidator.Check(value)) {
          if (value.data.stats.matches !== occurrences || value.data.stats.matched_lines !== matchingLines) throw new WorkspaceFailure('searchProtocolError');
          summarySeen = true;
        }
        else if (!otherValidator.Check(value)) throw new WorkspaceFailure('searchProtocolError');
      }
    }
    const receipt = await owned.closed;
    if (signal.aborted) throw new WorkspaceFailure('cancelled');
    if (failure || pending.length) throw new WorkspaceFailure('searchProtocolError');
    if (receipt.spawnError || receipt.signal || stderr || (preflight ? receipt.code !== 0 : receipt.code !== 0 && receipt.code !== 1)) {
      throw new WorkspaceFailure(preflight ? 'pcre2Unavailable' : 'searchFailed', { exit: receipt.code, signal: receipt.signal });
    }
    if (!preflight && !summarySeen) throw new WorkspaceFailure('searchProtocolError');
  } finally { signal.removeEventListener('abort', abort); await owned.stop(); }
}
