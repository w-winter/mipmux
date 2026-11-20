import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProcessSupervisor } from '../runtime/process-supervisor.js';
import type { GitMode } from '../contracts/patches.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { gitProcess } from './git-process.js';

export type FileSide = { readonly kind: 'absent' } | {
  readonly kind: 'file';
  readonly bytes: Buffer;
  readonly mode: GitMode;
} | {
  readonly kind: 'symlink';
  readonly bytes: Buffer;
};
export function equalSides(a: FileSide, b: FileSide): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  if (a.kind === 'file' && b.kind === 'file') return a.mode === b.mode && a.bytes.equals(b.bytes);
  return a.kind === b.kind && a.bytes.equals(b.bytes);
}
export async function bytePairDiff(
  supervisor: ProcessSupervisor,
  executable: string,
  workRoot: string,
  path: string,
  before: FileSide,
  after: FileSide,
  signal: AbortSignal,
): Promise<Buffer> {
  if (equalSides(before, after)) return Buffer.alloc(0);
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(workRoot, 'diff-'));
  try {
    for (const [prefix, side] of [['a', before], ['b', after]] as const) {
      if (side.kind === 'absent') continue;
      const destination = join(scratch, prefix, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      if (side.kind === 'symlink') await symlink(side.bytes, destination);
      else {
        await writeFile(destination, side.bytes, { flag: 'wx', mode: 0o600 });
        await chmod(destination, side.mode === '100755' ? 0o755 : 0o644);
      }
    }
    const both = before.kind !== 'absent' && after.kind !== 'absent';
    const cwd = both ? scratch : join(scratch, before.kind !== 'absent' ? 'a' : 'b');
    const sides = both
      ? ['a/' + path, 'b/' + path]
      : before.kind === 'absent'
      ? ['/dev/null', path]
      : [path, '/dev/null'];
    const result = await gitProcess(
      supervisor,
      executable,
      cwd,
      [
        'diff',
        '--no-index',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--full-index',
        '--binary',
        '--unified=3',
        '--diff-algorithm=myers',
        '--no-indent-heuristic',
        ...(both ? ['--no-prefix'] : ['--src-prefix=a/', '--dst-prefix=b/']),
        '--',
        ...sides,
      ],
      signal,
      { kind: 'scratch', ceiling: workRoot },
    );
    if (
      result.code !== 1 || result.diagnostics || !result.bytes.length ||
      !result.bytes.subarray(0, 11).equals(Buffer.from('diff --git '))
    ) {
      throw new WorkspaceFailure('patchComparisonFailed', { exit: result.code });
    }
    return result.bytes;
  } finally {
    await rm(scratch, { recursive: true });
  }
}
