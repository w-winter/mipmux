import Type, { type Static } from 'typebox';
import { NativeGitChangedFile } from './git.js';

const closed = { additionalProperties: false };
const text = Type.Union([Type.String(), Type.Null()]);
export const NativeGitSnapshotInput = Type.Object({
  snapshotID: Type.String(), repoKey: Type.String(), mode: Type.Enum(['quick', 'standard', 'deep']),
  scope: Type.Enum(['all', 'selected']), requestedPaths: Type.Union([Type.Array(Type.String()), Type.Null()]),
  compare: Type.String(), compareInput: text, diffText: text,
  perFile: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
  changedFiles: Type.Array(NativeGitChangedFile),
  summary: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, closed),
  fingerprint: Type.Object({ headSHA: Type.String(), baseRef: Type.String(), statusHash: Type.String(), generatedAt: Type.String() }, closed),
  contextLines: Type.Integer(), detectRenames: Type.Boolean(), commitGraph: Type.String(), repoRoot: text, tabID: text,
  worktree: Type.Union([Type.Object({ isWorktree: Type.Boolean(), worktreeName: text, worktreeRoot: text,
    mainWorktreeRoot: text, commonGitDir: text }, closed), Type.Null()]),
}, closed);
export type GitSnapshotContent = Pick<Static<typeof NativeGitSnapshotInput>,
  'scope' | 'requestedPaths' | 'diffText' | 'perFile' | 'changedFiles' | 'summary' | 'fingerprint'>;
