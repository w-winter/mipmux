import { toolSchemas, type DiscoveryInput } from '../contracts/discovery.js';
import type { CapturedContextBuildRequest } from '../contracts/context.js';
import type { NativeOperation, NativeResult } from '../contracts/native.js';
import { scoutTokenBudget } from './budget.js';
import { defaultQuestionTimeoutSeconds } from '../contracts/interaction.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';

export interface DiscoveryObservation {
  readonly context: string;
  readonly tree: string;
  readonly prompt: string;
  readonly roots: readonly string[];
}

/** Captures one draft observation and applies the discovery reserve once. */
export function captureDiscoveryInput(request: CapturedContextBuildRequest,
  view: DiscoveryObservation, restrictsReviewGitToExplicitReadOnly: boolean): DiscoveryInput {
  const tokenBudget = scoutTokenBudget(request.budgetUnits);
  const input = { tokenBudget, purpose: request.purpose, enhancementMode: request.enhancementMode,
    task: request.task, constraints: request.constraints, hints: [...request.discoveryHints], roots: [...view.roots],
    initialContext: view.context, fileTree: view.tree, currentPrompt: view.prompt, restrictsReviewGitToExplicitReadOnly };
  if (!request.clarification) return freeze(input);
  return freeze({ ...input, clarification: {
    questionTimeoutSeconds: request.clarification.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds,
  } });
}

type DiscoveryPromptOperation = Extract<NativeOperation, { kind: 'renderDiscoveryPrompt' }>;
export type DiscoveryPromptRenderer = (operation: DiscoveryPromptOperation, signal: AbortSignal) =>
  Promise<Extract<NativeResult, { kind: 'discoveryPrompt' | 'discoveryTemplateRejected' }>>;

/**
 * Fills each `{{mipmux:tool:<name>}}` placeholder that names a discovery tool with the tool's name as the model sees it:
 * `toolPrefix` followed by the name. Other placeholders stay for the native renderer, which rejects unknown ones by line;
 * substitution keeps every line break, so those lines stay correct.
 */
export function bindToolNames(template: string, toolPrefix: string): string {
  return template.replace(/\{\{mipmux:tool:([a-z_]+)\}\}/g, (token, name: string) => Object.hasOwn(toolSchemas, name) ? toolPrefix + name : token);
}

/**
 * Composes both startup channels from admitted template text, the captured facts, whether the session offers codemode and
 * the prefix of the model's tool names: empty for Pi, which offers the tools under their own names.
 */
export async function prepareDiscoveryInput(input: DiscoveryInput, template: string, codemode: boolean, toolPrefix: string, signal: AbortSignal,
  render: DiscoveryPromptRenderer) {
  const result = await render({ kind: 'renderDiscoveryPrompt', template: bindToolNames(template, toolPrefix), tokenBudget: input.tokenBudget, codemode,
    enhancementMode: input.enhancementMode, purpose: input.purpose, task: input.task,
    allowClarifyingQuestions: input.clarification !== undefined,
    questionTimeoutSeconds: input.clarification?.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds,
    restrictsReviewGitToExplicitReadOnly: input.restrictsReviewGitToExplicitReadOnly, reviewRootNames: [...input.roots],
    fileTree: input.fileTree, currentPrompt: input.currentPrompt, discoveryInstructions: [input.task, ...input.hints].join('\n\n') }, signal);
  if (result.kind === 'discoveryTemplateRejected') throw new WorkspaceFailure('invalidDiscoveryTemplate', result.diagnostic);
  return { systemPrompt: result.text, message: result.message };
}
