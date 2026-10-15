import type { DiscoveryInput } from '../contracts/discovery.js';
import type { ContextBuildRequest } from '../contracts/context.js';
import type { SmipRuntime } from '../runtime/smip-runtime.js';
import { scoutTokenBudget } from './budget.js';
import { defaultQuestionTimeoutSeconds } from '../contracts/interaction.js';

export interface DiscoveryObservation {
  readonly context: string;
  readonly tree: string;
  readonly prompt: string;
  readonly roots: readonly string[];
}

/** Uses one captured draft observation for the source policy and ordered startup sections. */
export async function prepareDiscoveryInput(runtime: SmipRuntime, request: ContextBuildRequest,
  view: DiscoveryObservation, restrictsReviewGitToExplicitReadOnly: boolean, signal: AbortSignal): Promise<DiscoveryInput> {
  const tokenBudget = scoutTokenBudget(request.budgetUnits);
  const policy = await runtime.renderPresentation({ kind: 'renderDiscoveryPrompt', tokenBudget,
    runtime: 'codexExec', enhancementMode: request.enhancementMode, allowClarifyingQuestions: request.clarification !== undefined,
    responseType: request.purpose === 'investigation' ? 'clarify' : request.purpose === 'planning' ? 'plan' : 'review',
    instructions: request.task, questionTimeoutSeconds: request.clarification?.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds,
    restrictsReviewGitToExplicitReadOnly, reviewRootNames: [...view.roots] }, signal);
  const startup = await runtime.renderPresentation({ kind: 'renderDiscoveryMessage', tokenBudget, fileTree: view.tree,
    currentPrompt: view.prompt, discoveryInstructions: request.discoveryHints.join('\n\n'),
    contextBuilderPrompts: request.contextBuilderPrompts ?? [] }, signal);
  const input = { tokenBudget, purpose: request.purpose, enhancementMode: request.enhancementMode,
    task: request.task, constraints: request.constraints, hints: [...request.discoveryHints], roots: [...view.roots],
    initialContext: view.context, systemPrompt: policy.text, message: startup.text };
  if (!request.clarification) return input;
  return { ...input, clarification: {
    questionTimeoutSeconds: request.clarification.questionTimeoutSeconds ?? defaultQuestionTimeoutSeconds,
  } };
}
