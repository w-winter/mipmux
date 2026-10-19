import type { CopyContext } from '../../src/contracts/presentation.js';
import type { CapturedContextBuildRequest, ContextBuildRequest } from '../../src/contracts/context.js';

export function copyContext(): CopyContext {
  return { current: { fileTreeMode: 'Auto', codeMapUsage: 'auto', gitInclusion: 'none' },
    customizations: { includeFiles: null, includeUserPrompt: null, includeMetaPrompts: null, includeFileTree: null,
      fileTreeMode: null, codeMapUsage: null, gitInclusion: null },
    codeMapsGloballyDisabled: false, selectedPromptIds: [], activeGitRoot: null, presets: [] };
}

export function buildRequest(captured: CapturedContextBuildRequest): ContextBuildRequest {
  const { copyContext: _context, copyPresetSelector, copyPreset: _preset, ...request } = captured;
  return { ...request, copyPreset: copyPresetSelector };
}
