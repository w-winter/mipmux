import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { RelativePath, RootName, RootIdentity } from './workspace.js';

const closed = { additionalProperties: false };
const output = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const GitRequest = Type.Union([
  Type.Object({ op: Type.Literal('log'), root: RootName, count: Type.Integer({ default: 10 }),
    path: Type.Union([RelativePath, Type.Null()], { default: null }), maxOutputBytes: output }, closed),
  Type.Object({ op: Type.Literal('blame'), root: RootName, path: RelativePath,
    lines: Type.Union([Type.String(), Type.Null()], { default: null }), maxOutputBytes: output }, closed),
  Type.Object({ op: Type.Literal('status'), root: RootName, maxOutputBytes: output }, closed),
  Type.Object({ op: Type.Literal('show'), root: RootName, ref: Type.String({ pattern: '^[^\\u0000]*$' }),
    detail: Type.String({ default: 'summary' }), contextLines: Type.Integer({ default: 3 }),
    detectRenames: Type.Boolean({ default: false }), maxOutputBytes: output }, closed),
  Type.Object({ op: Type.Literal('diff'), root: Type.Union([RootName, Type.Null()], { default: null }), compare: Type.String({ pattern: '^[^\\u0000]*$', default: 'uncommitted' }),
    worktree: Type.Union([Type.String({ pattern: '^/[^\\u0000]*$' }), Type.Null()], { default: null }),
    path: Type.Union([Type.String(), Type.Null()], { default: null }), paths: Type.Array(Type.String(), { default: [] }),
    detail: Type.String({ default: 'summary' }), contextLines: Type.Integer({ default: 3 }),
    detectRenames: Type.Boolean({ default: false }), maxOutputBytes: output }, closed),
]);
export type GitRequest = Static<typeof GitRequest>;
export const GitInput = Type.Union([
  Type.Object({ op: Type.Literal('log'), root: RootName, count: Type.Optional(GitRequest.anyOf[0].properties.count),
    path: Type.Optional(GitRequest.anyOf[0].properties.path) }, closed),
  Type.Object({ op: Type.Literal('blame'), root: RootName, path: RelativePath,
    lines: Type.Optional(GitRequest.anyOf[1].properties.lines) }, closed),
  Type.Object({ op: Type.Literal('status'), root: RootName }, closed),
  Type.Object({ op: Type.Literal('show'), root: RootName, ref: GitRequest.anyOf[3].properties.ref,
    detail: Type.Optional(GitRequest.anyOf[3].properties.detail), contextLines: Type.Optional(GitRequest.anyOf[3].properties.contextLines),
    detectRenames: Type.Optional(GitRequest.anyOf[3].properties.detectRenames) }, closed),
  Type.Object({ op: Type.Literal('diff'), root: Type.Optional(GitRequest.anyOf[4].properties.root),
    ...Type.Partial(Type.Omit(GitRequest.anyOf[4], ['op', 'root', 'maxOutputBytes'])).properties }, closed),
]);
export const gitValidator = Compile(GitRequest);
export const NativeGitReadQuery = Type.Union([
  Type.Object({ op: Type.Literal('log'), count: Type.Integer(), path: Type.Union([Type.String(), Type.Null()]) }, closed),
  Type.Object({ op: Type.Literal('blame'), path: Type.String(), lines: Type.Union([Type.String(), Type.Null()]) }, closed),
  Type.Object({ op: Type.Literal('status') }, closed),
]);
const commit = Type.Object({ sha: Type.String(), short_sha: Type.String(), author: Type.String(), date: Type.String(), message: Type.String(),
  files_changed: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, closed);
const blame = Type.Object({ num: Type.Integer(), sha: Type.String(), author: Type.String(), date: Type.String(), content: Type.String() }, closed);
const status = Type.Object({ branch: Type.Optional(Type.String()), upstream: Type.Optional(Type.String()),
  ahead: Type.Optional(Type.Integer()), behind: Type.Optional(Type.Integer()), staged: Type.Array(Type.String()),
  modified: Type.Array(Type.String()), untracked: Type.Array(Type.String()), summary: Type.String() }, closed);
export const NativeGitReadResult = Type.Union([
  Type.Object({ kind: Type.Literal('gitReadArguments'), args: Type.Array(Type.String()) }, closed),
  Type.Object({ kind: Type.Literal('gitLog'), commits: Type.Array(commit) }, closed),
  Type.Object({ kind: Type.Literal('gitBlame'), lines: Type.Array(blame) }, closed),
  Type.Object({ kind: Type.Literal('gitStatus'), status }, closed),
  Type.Object({ kind: Type.Literal('gitStatusError'), message: Type.String() }, closed),
]);
const hunk = Type.Object({ header: Type.String(), old_start: Type.Integer(), new_start: Type.Integer(), patch: Type.String() }, closed);
const show = Type.Object({ sha: Type.String(), short_sha: Type.String(), author: Type.String(), date: Type.String(), message: Type.String(),
  totals: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, closed),
  files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), status: Type.String(), insertions: Type.Optional(Type.Integer()),
    deletions: Type.Optional(Type.Integer()), hunks: Type.Optional(Type.Array(hunk)) }, closed))),
  hunks: Type.Optional(Type.Array(hunk)) }, closed);
export const NativeGitShowResult = Type.Object({ kind: Type.Literal('gitShow'), show }, closed);
export const GitDiff = Type.Object({ compare: Type.String(), detail: Type.Optional(Type.String()),
  totals: Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, closed),
  files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), status: Type.String(), insertions: Type.Optional(Type.Integer()),
    deletions: Type.Optional(Type.Integer()), hunks: Type.Optional(Type.Array(hunk)) }, closed))),
  by_status: Type.Optional(Type.Record(Type.String(), Type.Integer())), oneliner: Type.String(), truncated: Type.Optional(Type.Boolean()),
  truncation_note: Type.Optional(Type.String()) }, closed);
const authority = { kind: Type.Literal('git'), root: RootName, repository: Type.Object({ worktree: RootIdentity, gitDirectory: RootIdentity }, closed) };
export const GitResult = Type.Union([
  Type.Object({ ...authority, op: Type.Literal('diff'), diff: GitDiff, exclusions: Type.Array(Type.String()) }, closed),
  Type.Object({ ...authority, op: Type.Literal('show'), show, exclusions: Type.Array(Type.String()) }, closed),
  Type.Object({ ...authority, op: Type.Literal('status'), status }, closed),
  Type.Object({ ...authority, op: Type.Literal('log'), log: Type.Object({ commits: Type.Array(commit) }, closed) }, closed),
  Type.Object({ ...authority, op: Type.Literal('blame'), blame: Type.Object({ path: RelativePath, lines: Type.Array(blame) }, closed) }, closed),
]);
