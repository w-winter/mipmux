import Type, { type Static } from 'typebox';
import { SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
const nullableText = Type.Union([Type.String(), Type.Null()]);
/** RPCE component totals, separate from the cost of the complete serialized packet. */
export const ReferenceTokenStats = Type.Object({ total: SafeCount, files: SafeCount,
  prompt: Type.Optional(SafeCount), file_tree: Type.Optional(SafeCount), meta: Type.Optional(SafeCount),
  git: Type.Optional(SafeCount), other: Type.Optional(SafeCount), files_content: Type.Optional(SafeCount), codemaps: Type.Optional(SafeCount) }, closed);
export type ReferenceTokenStats = Static<typeof ReferenceTokenStats>;
export const NativeTokenStatsInput = Type.Object({ kind: Type.Literal('calculateTokenStats'),
  files: Type.Object({ fullTokens: SafeCount, sliceTokens: SafeCount, codemapTokens: SafeCount }, closed),
  promptText: Type.String(), selectedInstructionsText: Type.String(), fileTreeText: Type.String(),
  gitDiffText: nullableText, metadataText: nullableText, duplicateUserInstructionsAtTop: Type.Boolean() }, closed);
export const NativeTokenStatsResult = Type.Object({ kind: Type.Literal('tokenStats'), tokenStats: ReferenceTokenStats }, closed);
