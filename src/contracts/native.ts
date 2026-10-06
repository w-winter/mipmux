import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { DirectoryRef, RelativePath, RootIdentity, RootName, SafeCount, SHA256, SourceIdentity } from './workspace.js';
import { ArtifactKey, Projection, Base64, SyntaxOutcome } from './artifact.js';
import { NativeWireFailureCode } from './errors.js';

const handle = Type.Object({ generation: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type NativeHandle = Static<typeof handle>;
const base64 = Base64;
const access = Type.Union([Type.Literal('source'), Type.Literal('output')]);
const filename = Type.Union([Type.Literal('context.md'), Type.Literal('handoff.md')]);
const declaration = Type.Object({
  name: RootName, absolutePath: Type.String({ pattern: '^/[^\\u0000]*$' }), access,
  expected: Type.Union([RootIdentity, Type.Null()]),
}, { additionalProperties: false });
export const NativeOperation = Type.Union([
  Type.Object({ kind: Type.Literal('describe') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('openRoots'), roots: Type.Array(declaration, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('listDirectory'), root: handle, directory: DirectoryRef }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readSource'), root: handle, path: RelativePath, expected: Type.Union([SourceIdentity, Type.Null()]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('extract'), extension: Type.String(), bytes: base64, expected: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('beginExport'), root: handle, name: Type.String({ pattern: '^[^/\\u0000]+$' }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('writeExport'), run: handle, filename, bytes: base64 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readExport'), run: handle, filename }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('publishManifest'), run: handle, bytes: base64 }, { additionalProperties: false }),
]);
export type NativeOperation = Static<typeof NativeOperation>;
export const NativeRequest = Type.Object({
  wireVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }),
  generation: Type.String({ minLength: 1 }), operation: NativeOperation,
}, { additionalProperties: false });
export type NativeRequest = Static<typeof NativeRequest>;

const decimal = Type.String({ pattern: '^-?[0-9]+$' });
export const DescriptorFingerprint = Type.Object({
  device: decimal, inode: decimal, size: SafeCount, mode: SafeCount,
  modifiedSeconds: decimal, modifiedNanoseconds: SafeCount,
  changedSeconds: decimal, changedNanoseconds: SafeCount,
}, { additionalProperties: false });
export type DescriptorFingerprint = Static<typeof DescriptorFingerprint>;

export const NativeResult = Type.Union([
  Type.Object({ kind: Type.Literal('description'), decoderPolicy: Type.Literal('smip-strict-utf8-v1'),
    regexEngineFingerprint: SHA256,
    engine: Type.Object({ version: Type.String(), unicode: Type.String(), jitPolicy: Type.Union([Type.Literal('disabled'), Type.Literal('auto'), Type.Literal('required')]), jitCapability: Type.Boolean(), jitExecution: Type.Union([Type.Literal('disabled'), Type.Literal('compiled'), Type.Literal('unavailable')]) }, { additionalProperties: false }),
    extensions: Type.Array(Type.Object({ extension: Type.String(), pipelineCanonicalBase64: base64 }, { additionalProperties: false })),
    limits: Type.Object({ lines: SafeCount, utf16Units: SafeCount, utf8Bytes: SafeCount }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('rootsOpened'), roots: Type.Array(Type.Object({
    handle, name: RootName, access, identity: RootIdentity,
  }, { additionalProperties: false })) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('directoryComplete'), count: SafeCount, sha256: SHA256 }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('sourceComplete'), identity: SourceIdentity,
    fingerprint: DescriptorFingerprint, key: Type.Union([ArtifactKey, Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('extracted'), key: ArtifactKey,
    outcome: SyntaxOutcome, projection: Type.Union([Projection, Type.Null()]),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('unsupportedExtension') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportOpened'), run: handle }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportWritten'), identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('exportRead'), bytes: base64, identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('manifestPublished'), identity: SourceIdentity }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('failure'), code: NativeWireFailureCode, errno: Type.Union([Type.Integer(), Type.Null()]) }, { additionalProperties: false }),
]);
export type NativeResult = Static<typeof NativeResult>;
const envelope = { wireVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }), generation: Type.String({ minLength: 1 }) };
export const NativeFrame = Type.Union([
  Type.Object({ ...envelope, kind: Type.Literal('terminal'), result: NativeResult }, { additionalProperties: false }),
  Type.Object({ ...envelope, kind: Type.Literal('bytes'), bytes: base64 }, { additionalProperties: false }),
  Type.Object({ ...envelope, kind: Type.Literal('entry'), name: Type.String({ minLength: 1, pattern: '^[^/\\u0000]+$' }),
    entryKind: Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink'), Type.Literal('other')]),
  }, { additionalProperties: false }),
]);
export type NativeFrame = Static<typeof NativeFrame>;
export const nativeRequestValidator = Compile(NativeRequest);
export const nativeFrameValidator = Compile(NativeFrame);
