import type { ClaudeCodeDiscoveryReceipt, Completion, PiDiscoveryReceipt } from '../contracts/discovery.js';

type ModelIdentity = Completion['dispatched'];

/** How the model IDs a server reported for one response compare with the ID discovery expects it to report. */
export type ServerModelCheck = 'matched' | 'mismatched' | 'unreported';

/**
 * Without a declared served model, Pi records a server's model ID only when it differs from the catalog ID, so any
 * recorded ID other than the catalog's mismatches. With one, every ID the response's stream named must be the declared
 * one, and a response that did not end in an error or abort must have named it.
 */
export function checkServerModel(completion: Completion, catalogModel: string, expectedServerModel: string | null): ServerModelCheck {
  if (expectedServerModel === null) {
    return completion.serverModel === null || completion.serverModel === catalogModel ? 'matched' : 'mismatched';
  }
  const reported = completion.reportedServerModels ?? [];
  if (reported.some(model => model !== expectedServerModel)) return 'mismatched';
  return reported.length > 0 || completion.stopReason === 'error' || completion.stopReason === 'aborted' ? 'matched' : 'unreported';
}

/** Whether a response was dispatched to, and reported by, the effective model, and its server named the expected model. */
function matchesModel(completion: Completion, identity: ModelIdentity, expectedServerModel: string | null): boolean {
  return completion.dispatched.provider === identity.provider && completion.dispatched.model === identity.model &&
    completion.dispatched.api === identity.api && completion.reported.provider === identity.provider &&
    completion.reported.model === identity.model && completion.reported.api === identity.api &&
    checkServerModel(completion, identity.model, expectedServerModel) === 'matched';
}

/** Whether configured external MCP servers were ready and shut down; true without any. */
function mcpComplete(mcp: PiDiscoveryReceipt['mcp']): boolean {
  return mcp === null || (mcp.readiness.state === 'ready' && mcp.shutdown === 'dispatched');
}

/** Whether the last response is nonempty text, with any thinking, that ended the turn normally. */
function finalAnswer(last: Completion | null): last is Completion {
  return last !== null && last.stopReason === 'stop' && last.nonempty && last.textOnly;
}

/** Whether the Pi worker accepted one prompt and reported every lifecycle stage through its closure. */
function piLifecycleComplete(receipt: PiDiscoveryReceipt): boolean {
  return receipt.prompt === 'resolved' && receipt.acceptedRuns === 1 && receipt.settled && receipt.idle &&
    receipt.observationsSettled && receipt.disposed && receipt.workerClosed && receipt.parentToolsSettled;
}

export function completeDiscovery(receipt: PiDiscoveryReceipt): boolean {
  const last = receipt.finalAssistant, effective = receipt.effective;
  return piLifecycleComplete(receipt) && mcpComplete(receipt.mcp) && finalAnswer(last) && last.channel === 'ordinary' &&
    effective !== null && effective.identity.provider === receipt.requested.provider && effective.identity.model === receipt.requested.model &&
    effective.thinking === receipt.requested.thinking && receipt.completions.length > 0 &&
    receipt.completions.every(completion => matchesModel(completion, effective.identity, effective.expectedServerModel));
}

/**
 * Whether a Claude Code run completed: its one prompt was released, Claude Code reported success and closed, every tool
 * call settled, the startup message named the requested model, every response reported the model it serves, and the
 * last response is nonempty text that ended the turn.
 */
export function completeClaudeCodeDiscovery(receipt: ClaudeCodeDiscoveryReceipt): boolean {
  const effective = receipt.effective;
  return receipt.prompt === 'resolved' && receipt.result?.subtype === 'success' && receipt.childClosed && receipt.toolsSettled &&
    mcpComplete(receipt.mcp) && finalAnswer(receipt.finalAssistant) && effective !== null && effective.model === receipt.requested.model &&
    receipt.completions.length > 0 && receipt.completions.every(completion => completion.reported.model === effective.servedModel);
}
