import type { DiscoveryInput } from '../contracts/discovery.js';
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

/** Composes both startup channels from admitted template text and the captured facts. */
export async function prepareDiscoveryInput(input: DiscoveryInput, template: string, signal: AbortSignal, render: DiscoveryPromptRenderer) {
  const result = await render({ kind: 'renderDiscoveryPrompt', template, tokenBudget: input.tokenBudget,
    enhancementMode: input.enhancementMode, purpose: input.purpose, task: input.task,
    allowClarifyingQuestions: input.clarification !== undefined,
    questionTimeoutSeconds: input.clarification?.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds,
    restrictsReviewGitToExplicitReadOnly: input.restrictsReviewGitToExplicitReadOnly, reviewRootNames: [...input.roots],
    fileTree: input.fileTree, currentPrompt: input.currentPrompt, discoveryInstructions: input.hints.join('\n\n') }, signal);
  if (result.kind === 'discoveryTemplateRejected') throw new WorkspaceFailure('invalidDiscoveryTemplate', result.diagnostic);
  return { systemPrompt: result.text, message: result.message };
}
