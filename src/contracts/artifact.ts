import Type, { type Static } from 'typebox';
import { SafeCount, SHA256 } from './workspace.js';

const closed = { additionalProperties: false };
export const Base64 = Type.String({ pattern: '^[A-Za-z0-9+/]*={0,2}$' });
export const ArtifactKey = Type.Object({ canonicalBase64: Base64, digest: SHA256 }, closed);
export type ArtifactKey = Static<typeof ArtifactKey>;
export const Projection = Type.Object({ apiDescription: Type.String(), definedTypeNames: Type.Array(Type.String()) }, closed);

const parameter = Type.Object({
  externalName: Type.Optional(Type.String()), localName: Type.String(), typeName: Type.Optional(Type.String()),
}, { additionalProperties: false });
const fn = Type.Object({
  name: Type.String(), parameters: Type.Array(parameter), returnType: Type.Optional(Type.String()),
  definitionLine: Type.String(), lineNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, { additionalProperties: false });
const property = Type.Object({ name: Type.String(), typeName: Type.Optional(Type.String()) }, { additionalProperties: false });
const container = Type.Object({ name: Type.String(), properties: Type.Array(property), methods: Type.Array(fn) }, { additionalProperties: false });
export const SyntaxArtifact = Type.Object({
  imports: Type.Array(Type.String()), exports: Type.Array(Type.String()),
  classes: Type.Array(container), interfaces: Type.Array(container),
  aliases: Type.Array(Type.Object({ name: Type.String(), definitionLine: Type.String() }, { additionalProperties: false })),
  literalUnions: Type.Array(Type.String()), functions: Type.Array(fn),
  enums: Type.Array(Type.Object({ name: Type.String(), cases: Type.Array(Type.String()) }, { additionalProperties: false })),
  globalVars: Type.Array(Type.Object({ name: Type.String(), typeName: Type.Optional(Type.String()), definitionLine: Type.String() }, { additionalProperties: false })),
  macros: Type.Array(Type.String()), referencedTypes: Type.Array(Type.String()),
}, { additionalProperties: false });
export const SyntaxOutcome = Type.Union([
  Type.Object({ kind: Type.Literal('ready'), artifact: SyntaxArtifact }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('readyNoSymbols') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('decodeFailed'), failure: Type.Literal('undecodable') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('parseFailed'), failure: Type.Union([Type.Literal('parserReturnedNilTree'), Type.Literal('parserReturnedNilRoot')]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('oversize'), reason: Type.Object({
    kind: Type.Union([Type.Literal('utf8Bytes'), Type.Literal('utf16Units'), Type.Literal('lines')]),
    actual: SafeCount, limit: SafeCount,
  }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
export type SyntaxOutcome = Static<typeof SyntaxOutcome>;
