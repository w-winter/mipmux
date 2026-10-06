import type { PatchInput } from '../contracts/patches.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { identity, type Material, strictText } from '../context/material-store.js';
import { freeze, WorkspaceFailure } from '../workspace/values.js';
import { acquireLocalPatch } from './local-git.js';

export async function acquirePatch(operation: WorkspaceOperation, input: PatchInput): Promise<Material> {
  if (input.kind === 'localPatch') {
    const patch = await acquireLocalPatch(operation, input);
    return freeze({
      record: { kind: 'patch', id: 'patch:' + input.id, receipt: patch.receipt, spans: [] },
      bodies: [strictText(patch.bytes.toString('utf8'))],
    });
  }
  if (
    new Set(input.coverage).size !== input.coverage.length ||
    new Set(input.targets.map((t) => t.path)).size !== input.targets.length
  ) throw new WorkspaceFailure('invalidPatchCoverage');
  const text = strictText(input.text);
  const policies = [];
  for (const path of [...new Set([...input.coverage, ...input.targets.map((target) => target.path)])].sort()) {
    policies.push({ path, policy: await operation.authorizeComparisonPath({ root: input.root, path }) });
  }
  return freeze({
    record: {
      kind: 'patch',
      id: 'patch:' + input.id,
      receipt: {
        input,
        identity: identity(text),
        coverage: input.coverage,
        targets: input.targets,
        policies,
        exclusions: [],
        repository: null,
      },
      spans: [],
    },
    bodies: [text],
  });
}
