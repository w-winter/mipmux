import Type, { type Static } from 'typebox';

const closed = { additionalProperties: false };
/** Clipboard presets retain source inclusion and saved-prompt choices; role bodies come from the caller catalog. */
export const ClipboardPreset = Type.Enum(['standard', 'codeReview']);
export type ClipboardPreset = Static<typeof ClipboardPreset>;
export const StoredPrompt = Type.Object({ id: Type.String({ format: 'uuid' }), title: Type.String(), content: Type.String() }, closed);
export type StoredPrompt = Static<typeof StoredPrompt>;
// Stable saved-review UUID from BuiltInCopyPresets at the pinned RPCE revision.
const reviewStoredPromptID = 'd7f1b2e4-3c5a-6b8d-cf8e-1f5d0e2a4c6b';
/** Exact source preset projection accepted from native assembly and archived manifests. */
export const CapturedClipboardPreset = Type.Union([
  Type.Object({ kind: Type.Literal('standard'), includeMetaPrompts: Type.Literal(false), storedPromptIds: Type.Tuple([]) }, closed),
  Type.Object({ kind: Type.Literal('codeReview'), includeMetaPrompts: Type.Literal(true),
    storedPromptIds: Type.Tuple([Type.Literal(reviewStoredPromptID)]) }, closed),
]);
export type CapturedClipboardPreset = Static<typeof CapturedClipboardPreset>;
