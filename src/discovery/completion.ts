import type { DiscoveryReceipt } from '../contracts/discovery.js';

export function completeDiscovery(receipt: DiscoveryReceipt): boolean {
  const last = receipt.finalAssistant, effective = receipt.effective;
  return receipt.prompt === 'resolved' && receipt.acceptedRuns === 1 && receipt.settled && receipt.idle &&
    receipt.observationsSettled && receipt.disposed && receipt.workerClosed && receipt.parentToolsSettled &&
    last !== null && last.channel === 'ordinary' &&
    last.stopReason === 'stop' && last.nonempty && last.textOnly && effective !== null &&
    effective.identity.provider === receipt.requested.provider && effective.identity.model === receipt.requested.model &&
    effective.thinking === receipt.requested.thinking && receipt.completions.length > 0 &&
    receipt.completions.every(completion => completion.dispatched.provider === effective.identity.provider &&
      completion.dispatched.model === effective.identity.model && completion.dispatched.api === effective.identity.api &&
      completion.reported.provider === effective.identity.provider && completion.reported.model === effective.identity.model &&
      completion.reported.api === effective.identity.api && (completion.serverModel === null || completion.serverModel === effective.identity.model));
}
