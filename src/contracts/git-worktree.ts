import Type from 'typebox';
import { GitArtifactWorktree } from './git-artifact.js';

const closed = { additionalProperties: false };
const text = Type.Union([Type.String(), Type.Null()]);
const record = Type.Object({ path: Type.String(), head: Type.Optional(Type.String()), branch: Type.Optional(Type.String()),
  isDetached: Type.Boolean(), isBare: Type.Boolean(), isLocked: Type.Boolean(), lockReason: Type.Optional(Type.String()),
  isPrunable: Type.Boolean(), prunableReason: Type.Optional(Type.String()) }, closed);
export const NativeGitWorktreeInput = Type.Union([
  Type.Object({ kind: Type.Literal('prepareGitWorktreeMainRoot'), repoRoot: Type.String(), listing: Type.String() }, closed),
  Type.Object({ kind: Type.Literal('resolveGitWorktreeConfig'), repoRoot: Type.String(), config: Type.String() }, closed),
  Type.Object({ kind: Type.Literal('projectGitWorktreeListing'), repoRoot: Type.String(), records: Type.Array(record), mainRoot: text }, closed),
  Type.Object({ kind: Type.Literal('renderGitWorktreeReply'), repoRoot: Type.String(), rootName: Type.String(), mainRoot: text,
    branch: text, head: text, mainBranch: text, mainHead: text }, closed),
]);
export const NativeGitWorktreeResult = Type.Union([
  Type.Object({ kind: Type.Literal('gitWorktreePlan'), mainRoot: text, records: Type.Array(record),
    queries: Type.Array(Type.Object({ directory: Type.String(), arguments: Type.Array(Type.String()) }, closed)) }, closed),
  Type.Object({ kind: Type.Literal('gitWorktreeMainRoot'), path: text }, closed),
  Type.Object({ kind: Type.Literal('gitWorktreeListing'), mainRoot: text, paths: Type.Array(Type.String()) }, closed),
  Type.Object({ kind: Type.Literal('gitWorktreeListingError'), message: Type.String() }, closed),
  Type.Object({ kind: Type.Literal('gitWorktreeReply'), worktree: GitArtifactWorktree, warning: Type.String() }, closed),
]);
