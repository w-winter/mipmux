import type { RawCopyPreset } from '../contracts/presentation.js';
import type { MipmuxRuntime } from '../runtime/mipmux-runtime.js';
import { serializedBytes, type ResultEncoding } from '../exploration/output-budget.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

export interface PresetDescriptor {
  id: string;
  name: string;
  is_built_in: boolean;
  kind?: Exclude<RawCopyPreset['builtInKind'], null>;
}
export interface PresetListItem {
  preset: PresetDescriptor;
  description?: string;
  icon?: string;
  include_files?: boolean;
  include_user_prompt?: boolean;
  include_file_tree?: boolean;
  file_tree_mode?: Exclude<RawCopyPreset['fileTreeMode'], null>;
  codemap_usage?: Exclude<RawCopyPreset['codeMapUsage'], null>;
  git_inclusion?: Exclude<RawCopyPreset['gitInclusion'], null>;
}

export function presetDescriptor(preset: RawCopyPreset): PresetDescriptor {
  const result: PresetDescriptor = { id: preset.id.toUpperCase(), name: preset.name, is_built_in: preset.isBuiltIn };
  if (preset.builtInKind !== null) result.kind = preset.builtInKind;
  return result;
}

function presetListItem(raw: RawCopyPreset): PresetListItem {
  const result: PresetListItem = { preset: presetDescriptor(raw) };
  if (raw.description !== null) result.description = raw.description;
  if (raw.icon !== null) result.icon = raw.icon;
  if (raw.includeFiles !== null) result.include_files = raw.includeFiles;
  if (raw.includeUserPrompt !== null) result.include_user_prompt = raw.includeUserPrompt;
  if (raw.includeFileTree !== null) result.include_file_tree = raw.includeFileTree;
  if (raw.fileTreeMode !== null) result.file_tree_mode = raw.fileTreeMode;
  if (raw.codeMapUsage !== null) result.codemap_usage = raw.codeMapUsage;
  if (raw.gitInclusion !== null) result.git_inclusion = raw.gitInclusion;
  return result;
}

export function admitPromptReply<T>(reply: T, maxOutputBytes: number, encode: ResultEncoding): T {
  const requiredBytes = serializedBytes(encode(reply));
  if (requiredBytes > maxOutputBytes) throw new WorkspaceFailure('outputBudgetTooSmall', { requiredBytes });
  return freeze(reply);
}

export async function listPromptPresets(runtime: MipmuxRuntime, signal: AbortSignal, maxOutputBytes: number, encode: ResultEncoding) {
  const catalog = await runtime.renderPresentation({ kind: 'listCopyPresets', context: runtime.options.copyContext }, signal);
  const presets = catalog.presets.map(presetListItem);
  return admitPromptReply({ op: 'list_presets' as const, presets_list: { presets } }, maxOutputBytes, encode);
}
