import type { InventorySnapshot, InventoryEntry, PolicySnapshot } from '../contracts/inventory.js';
import type { FileEntry } from './inventory-file.js';
import { inventoryDigest } from './artifact-store.js';
import { canonicalJSON, compareBytes, freeze, sha256, WorkspaceFailure } from './values.js';

export interface ManagedRegistration { readonly entry: FileEntry; readonly policy: PolicySnapshot }
export const entryKey = (entry: { readonly root: string; readonly path: string }) => canonicalJSON([entry.root, entry.path]);

function mergePolicy(roots: Map<string, PolicySnapshot['roots'][number]>,
  inputs: Map<string, PolicySnapshot['inputs'][number]>, policy: PolicySnapshot): void {
  for (const root of policy.roots) {
    const previous = roots.get(root.root);
    if (previous && canonicalJSON(previous) !== canonicalJSON(root)) throw new WorkspaceFailure('policyChanged');
    roots.set(root.root, root);
  }
  for (const input of policy.inputs) {
    const previous = inputs.get(entryKey(input));
    if (previous && canonicalJSON(previous) !== canonicalJSON(input)) throw new WorkspaceFailure('policyChanged');
    inputs.set(entryKey(input), input);
  }
}
function insertFile(entries: Map<string, InventoryEntry>, entry: FileEntry): void {
  entries.set(entryKey(entry), entry);
  const parts = entry.path.split('/'); parts.pop();
  for (let index = 1; index <= parts.length; index++) {
    const directory: InventoryEntry = { kind: 'directory', root: entry.root, path: parts.slice(0, index).join('/'), visibility: entry.visibility };
    if (entries.get(entryKey(directory))?.kind !== 'directory') entries.set(entryKey(directory), directory);
  }
}
export function managedInventory(base: InventorySnapshot, registrations: Iterable<ManagedRegistration>): InventorySnapshot {
  const entries = new Map(base.entries.map(entry => [entryKey(entry), entry]));
  const roots = new Map(base.policy.roots.map(root => [root.root, root]));
  const inputs = new Map(base.policy.inputs.map(input => [entryKey(input), input]));
  for (const { entry, policy } of registrations) {
    const key = entryKey(entry), previous = entries.get(key);
    if (previous?.kind === 'file' && previous.visibility === 'discoverable') continue;
    mergePolicy(roots, inputs, policy);
    insertFile(entries, entry);
  }
  const policyBody = { implementation: base.policy.implementation,
    roots: [...roots.values()].sort((a, b) => compareBytes(a.root, b.root)),
    inputs: [...inputs.values()].sort((a, b) => compareBytes(entryKey(a), entryKey(b))) };
  const body = { ...base, policy: { ...policyBody, digest: sha256(canonicalJSON(policyBody)) },
    entries: [...entries.values()].sort((a, b) => compareBytes(a.root, b.root) || compareBytes(a.path, b.path)) };
  return freeze({ ...body, inventoryDigest: inventoryDigest(body) });
}
