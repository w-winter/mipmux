import Type, { type Static } from 'typebox';

export const SafeCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const SHA256 = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const RelativePath = Type.String({
  minLength: 1,
  pattern: '^(?!/)(?![\\s\\S]*(?:^|/)(?:\\.\\.?)(?:/|$))[^\\u0000/]+(?:/[^\\u0000/]+)*$',
});
export const RootName = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' });
export const SourceIdentity = Type.Object({ sha256: SHA256, byteCount: SafeCount }, { additionalProperties: false });
export type SourceIdentity = Static<typeof SourceIdentity>;
export const RootIdentity = Type.Object({
  declaredPath: Type.String({ pattern: '^/[^\\u0000]*$' }),
  canonicalPath: Type.String({ pattern: '^/[^\\u0000]*$' }),
  device: Type.String({ pattern: '^-?[0-9]+$' }),
  inode: Type.String({ pattern: '^[0-9]+$' }),
}, { additionalProperties: false });
export type RootIdentity = Static<typeof RootIdentity>;
export const DirectoryRef = Type.Union([
  Type.Object({ kind: Type.Literal('root') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('descendant'), path: RelativePath }, { additionalProperties: false }),
]);
export type DirectoryRef = Static<typeof DirectoryRef>;
