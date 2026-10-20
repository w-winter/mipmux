import Type, { type Static, type TSchema } from 'typebox';

const closed = { additionalProperties: false };
export const defaultPromptSectionsOrder = ['fileMap', 'fileContents', 'gitDiff', 'constraints', 'userInstructions'] as const;
export const PromptSection = Type.Enum(defaultPromptSectionsOrder);
export type PromptSection = Static<typeof PromptSection>;
/** Every section must be present; repeated sections retain their configured positions. */
export const PromptSectionsOrder = Type.Array(PromptSection, {
  allOf: defaultPromptSectionsOrder.map(section => ({ contains: Type.Literal(section) })),
});
export const FileTreeMode = Type.Enum(['Auto', 'Full', 'Selected', 'None']);
export const CodeMapUsage = Type.Enum(['none', 'auto', 'selected', 'complete']);
export const GitInclusion = Type.Enum(['none', 'selected', 'complete']);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const CopyContext = Type.Object({
  current: Type.Object({ fileTreeMode: FileTreeMode, codeMapUsage: CodeMapUsage,
    gitInclusion: Type.Enum(['none', 'selectedFiles', 'all']) }, closed),
  customizations: Type.Object({ includeFiles: nullable(Type.Boolean()), includeUserPrompt: nullable(Type.Boolean()),
    includeFileTree: nullable(Type.Boolean()), fileTreeMode: nullable(FileTreeMode),
    codeMapUsage: nullable(CodeMapUsage), gitInclusion: nullable(GitInclusion) }, closed),
  codeMapsGloballyDisabled: Type.Boolean(),
  activeGitRoot: nullable(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]*$' })),
  presets: Type.Array(Type.Object({ id: Type.String({ format: 'uuid' }), name: Type.String(),
    builtInKind: nullable(Type.Enum(['standard', 'manual', 'diffFollowUp', 'codeReview'])),
    description: nullable(Type.String()), icon: nullable(Type.String()), isBuiltIn: Type.Boolean(),
    includeFiles: nullable(Type.Boolean()), includeUserPrompt: nullable(Type.Boolean()),
    includeFileTree: nullable(Type.Boolean()), fileTreeMode: nullable(FileTreeMode), codeMapUsage: nullable(CodeMapUsage),
    gitInclusion: nullable(GitInclusion), notes: nullable(Type.String()) }, closed)),
}, closed);
export type CopyContext = Static<typeof CopyContext>;
export const RawCopyPreset = CopyContext.properties.presets.items;
export type RawCopyPreset = Static<typeof RawCopyPreset>;
export const ClipboardPreset = Type.Union([Type.String(), Type.Object({ id: Type.Optional(Type.String()),
  kind: Type.Optional(Type.String()), name: Type.Optional(Type.String()) }, closed)]);
export type ClipboardPreset = Static<typeof ClipboardPreset>;
/** Resolved context-formatting settings captured from native assembly for archive replay. */
export const CapturedClipboardPreset = Type.Object({ raw: RawCopyPreset, gitInclusion: GitInclusion, includeFiles: Type.Boolean(),
    includeUserPrompt: Type.Boolean(), includeFileTree: Type.Boolean(),
    fileTreeMode: FileTreeMode, codeMapUsage: CodeMapUsage }, closed);
export type CapturedClipboardPreset = Static<typeof CapturedClipboardPreset>;

export function usesPresetPresentation(preset: CapturedClipboardPreset): boolean {
  return preset.raw.builtInKind === 'manual' || preset.raw.builtInKind === null ||
    preset.codeMapUsage !== 'auto' || !preset.includeFiles || !preset.includeFileTree || preset.fileTreeMode !== 'Auto';
}
