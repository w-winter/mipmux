import { createHash } from 'node:crypto';

export class WorkspaceFailure extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}) { super(code); }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    return '{' + Object.entries(value).sort(([a], [b]) => compareBytes(a, b))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJSON(item)).join(',') + '}';
  }
  throw new Error('Non-JSON value');
}

export function compareBytes(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
