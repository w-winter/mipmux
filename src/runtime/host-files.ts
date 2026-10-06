import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { WorkspaceFailure } from '../workspace/values.js';

/** Reads an opened regular file and closes its descriptor on success, failure or cancellation. */
export async function readRegularFile(path: string, nonRegularFailure: WorkspaceFailure, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    signal?.throwIfAborted();
    if (!(await file.stat()).isFile()) throw nonRegularFailure;
    signal?.throwIfAborted();
    const bytes = await file.readFile(signal ? { signal } : {});
    signal?.throwIfAborted();
    return bytes;
  } finally { await file.close(); }
}
