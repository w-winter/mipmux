import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { DirectoryRef, RelativePath, RootIdentity, RootName, SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { ArtifactKey, Projection, Base64, SyntaxOutcome } from './artifact.js';

const closed = { additionalProperties: false };
export const DecoderPolicy = Type.Enum(['workspace-automatic-v1', 'workspace-automatic-linux-v1']);
export const SourceDecoding = Type.Union([
  Type.Object({ kind: Type.Literal('decoded'), identity: SourceIdentity, encoding: SafeCount }, closed),
  Type.Object({ kind: Type.Literal('undecodable') }, closed),
]);
export const SourcePath = Type.Object({ root: RootName, path: RelativePath }, closed);
export type SourcePath = Static<typeof SourcePath>;
export { ArtifactKey, Projection } from './artifact.js';
export const Exclusion = Type.Union([
  Type.Object({ kind: Type.Literal('prefix'), root: RootName, path: RelativePath }, closed),
  Type.Object({ kind: Type.Literal('glob'), root: RootName, pattern: Type.String({ minLength: 1 }) }, closed),
]);
export const WorkspaceSpec = Type.Object({
  roots: Type.Array(Type.Object({ name: RootName, absolutePath: Type.String({ pattern: '^/[^\u0000]*$' }) }, closed), { minItems: 1 }),
  exclusions: Type.Array(Exclusion), outputRoot: Type.String({ pattern: '^/[^\u0000]*$' }),
}, closed);
export type WorkspaceSpec = Static<typeof WorkspaceSpec>;
export const workspaceSpecValidator = Compile(WorkspaceSpec);
export const ArtifactRecord = Type.Object({ schemaVersion: Type.Literal(1), keyCanonicalBase64: Base64, keyDigest: SHA256,
  outcome: SyntaxOutcome, projection: Type.Optional(Projection), recordSHA256: SHA256 }, closed);
export type ArtifactRecord = Static<typeof ArtifactRecord>;
export const artifactValidator = Compile(ArtifactRecord);
export const IgnoreSettings = Type.Object({
  global: Type.String(), respectRepoIgnore: Type.Boolean(), respectCursorignore: Type.Boolean(),
  enableHierarchicalIgnores: Type.Boolean(),
}, closed);
export type IgnoreSettings = Static<typeof IgnoreSettings>;
export const IgnoreAuthority = Type.Union([
  Type.Object({ kind: Type.Literal('nonGit') }, closed),
  Type.Object({ kind: Type.Literal('git'), prefix: Type.String(),
    repositoryRoot: RootIdentity, gitDirectory: RootIdentity, commonDirectory: RootIdentity }, closed),
]);
export const IgnoreControl = Type.Object({
  path: Type.String({ pattern: '^/[^\\u0000]*$' }), directory: Type.String(),
  name: Type.Enum(['.gitignore', '.repo_ignore', '.cursorignore']), authority: Type.Enum(['mandatoryGit', 'secondary']),
  content: Type.Union([
    Type.Object({ kind: Type.Literal('absent') }, closed),
    Type.Object({ kind: Type.Literal('present'), resolvedPath: Type.String({ pattern: '^/[^\\u0000]*$' }),
      identity: SourceIdentity, text: Type.String() }, closed),
    Type.Object({ kind: Type.Literal('unavailable'), code: Type.String(), errno: Type.Union([Type.Integer(), Type.Null()]) }, closed),
  ]),
}, closed);
export const PolicyInput = Type.Object({ root: RootName, ...IgnoreControl.properties }, closed);
export type PolicyInput = Static<typeof PolicyInput>;
export const PolicyRoot = Type.Object({ root: RootName, authority: IgnoreAuthority, settings: IgnoreSettings }, closed);
export const PolicySnapshot = Type.Object({ implementation: Type.Literal('rpce-ignore-v1'),
  roots: Type.Array(PolicyRoot), inputs: Type.Array(PolicyInput), digest: SHA256 }, closed);
export type PolicySnapshot = Static<typeof PolicySnapshot>;
export const AdmittedRoot = Type.Object({ name: RootName, identity: RootIdentity }, closed);
export type AdmittedRoot = Static<typeof AdmittedRoot>;
const disposition = Type.Union([
  Type.Object({ kind: Type.Literal('artifact'), key: ArtifactKey, record: ArtifactRecord }, closed),
  Type.Object({ kind: Type.Literal('unsupported') }, closed),
]);
export const InventoryEntry = Type.Union([
  Type.Object({ kind: Type.Literal('file'), root: RootName, path: RelativePath, identity: SourceIdentity, decoding: SourceDecoding, structural: disposition }, closed),
  Type.Object({ kind: Type.Literal('directory'), root: RootName, path: RelativePath }, closed),
  Type.Object({ kind: Type.Literal('acquisitionFailed'), root: RootName, path: RelativePath, code: Type.String(), structural: Type.Union([
    Type.Object({ kind: Type.Literal('unsupported') }, closed),
    Type.Object({ kind: Type.Literal('pending') }, closed),
    Type.Object({ kind: Type.Literal('excluded'), reason: Type.Literal('nonRegular') }, closed),
  ]) }, closed),
  Type.Object({ kind: Type.Literal('skipped'), root: RootName, path: RelativePath,
    reason: Type.Union([Type.Literal('policy'), Type.Literal('symlink'), Type.Literal('nonRegular')]) }, closed),
]);
export type InventoryEntry = Static<typeof InventoryEntry>;
export const InventorySnapshot = Type.Object({ schemaVersion: Type.Literal(4), decoderPolicy: DecoderPolicy, workspaceKey: SHA256, roots: Type.Array(AdmittedRoot), outputRoot: RootIdentity,
  policy: PolicySnapshot, entries: Type.Array(InventoryEntry), generation: SafeCount, inventoryDigest: SHA256,
  processing: Type.Literal('settled'), enumeration: Type.Union([
    Type.Object({ kind: Type.Literal('complete') }, closed),
    Type.Object({ kind: Type.Literal('incomplete'), failures: Type.Array(Type.Object({ root: RootName, directory: DirectoryRef, code: Type.String() }, closed)) }, closed),
  ]),
}, closed);
export type InventorySnapshot = Static<typeof InventorySnapshot>;
export const inventoryValidator = Compile(InventorySnapshot);
