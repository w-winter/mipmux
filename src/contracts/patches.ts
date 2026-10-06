import Type, { type Static } from 'typebox';
import { RelativePath, RootIdentity, RootName, SourceIdentity } from './workspace.js';
import { PolicySnapshot } from './inventory.js';

const closed = { additionalProperties: false };
export const GitMode = Type.Enum(['100644', '100755']);
export type GitMode = Static<typeof GitMode>;
export function descriptorGitMode(mode: number): GitMode {
  return mode & 0o100 ? '100755' : '100644';
}
export const TargetEvidence = Type.Object({ path: RelativePath, identity: SourceIdentity, mode: GitMode }, closed);
export type TargetEvidence = Static<typeof TargetEvidence>;
const base = Type.Union([
  Type.Object({ kind: Type.Literal('empty') }, closed),
  Type.Object({ kind: Type.Literal('commit'), ref: Type.String({ minLength: 1 }) }, closed),
]);
export const LocalComparison = Type.Union([
  Type.Object({ kind: Type.Literal('worktree'), base, includeUntracked: Type.Boolean() }, closed),
  Type.Object({ kind: Type.Literal('staged'), base }, closed),
  Type.Object({ kind: Type.Literal('commits'), base, target: Type.String({ minLength: 1 }) }, closed),
]);
export const PatchInput = Type.Union([
  Type.Object({
    kind: Type.Literal('suppliedPatch'),
    id: Type.String({ minLength: 1 }),
    root: RootName,
    text: Type.String(),
    origin: Type.String({ minLength: 1 }),
    comparison: Type.Object({
      kind: Type.Literal('supplied'),
      base: Type.String({ minLength: 1 }),
      target: Type.String({ minLength: 1 }),
    }, closed),
    coverage: Type.Array(RelativePath),
    targets: Type.Array(TargetEvidence),
  }, closed),
  Type.Object({
    kind: Type.Literal('localPatch'),
    id: Type.String({ minLength: 1 }),
    root: RootName,
    comparison: LocalComparison,
    scope: Type.Union([
      Type.Object({ kind: Type.Literal('all') }, closed),
      Type.Object({ kind: Type.Literal('paths'), paths: Type.Array(RelativePath, { minItems: 1 }) }, closed),
    ]),
  }, closed),
]);
export type PatchInput = Static<typeof PatchInput>;
export const PatchReceipt = Type.Object({
  input: PatchInput,
  identity: SourceIdentity,
  coverage: Type.Array(RelativePath),
  targets: Type.Array(TargetEvidence),
  policies: Type.Array(Type.Object({ path: RelativePath, policy: PolicySnapshot }, closed)),
  exclusions: Type.Array(RelativePath),
  repository: Type.Union([
    Type.Null(),
    Type.Object({
      worktree: RootIdentity,
      gitDirectory: RootIdentity,
      head: Type.Union([Type.String(), Type.Null()]),
      base: Type.Union([Type.String(), Type.Null()]),
      target: Type.Union([Type.String(), Type.Null()]),
      indexDigest: Type.Union([Type.String(), Type.Null()]),
    }, closed),
  ]),
}, closed);
export type PatchReceipt = Static<typeof PatchReceipt>;
