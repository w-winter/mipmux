import type { Readable, Writable } from 'node:stream';

export function send(output: Writable, value: unknown): void {
  output.write(JSON.stringify(value) + '\n');
}

/** LF framing rejects malformed UTF-8 and incomplete records at stream closure. */
export function receive(input: Readable, accept: (value: unknown) => void, fail: () => void): void {
  let pending = Buffer.alloc(0), failed = false;
  input.on('data', (chunk: Buffer) => {
    if (failed) return;
    try {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(pending.subarray(0, end)));
        pending = pending.subarray(end + 1); accept(value);
      }
    } catch { failed = true; fail(); }
  });
  input.on('end', () => { if (pending.length && !failed) { failed = true; fail(); } });
  input.on('error', () => { if (!failed) { failed = true; fail(); } });
}
