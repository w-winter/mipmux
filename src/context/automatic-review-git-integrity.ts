// Parses RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3 framing; see docs/vendor-provenance.json.
import type { AutomaticReviewGitCapture } from './automatic-review-git.js';
import type { AutomaticReviewGitEvidence, CapturedContextBuildRequest, SourceSelection, Span } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import { posix } from 'node:path';
import { contains } from '../workspace/root-policy.js';
import { sha256, WorkspaceFailure } from '../workspace/values.js';

function verifyCompleteness({ outcomes, pathIssues, completeness }: AutomaticReviewGitEvidence): void {
  const failures = pathIssues.length > 0 || outcomes.some(outcome => outcome.kind === 'baseResolutionFailed' || outcome.kind === 'commandFailed');
  const successes = outcomes.some(outcome => outcome.kind === 'diff' || outcome.kind === 'noChanges');
  if (completeness !== (!failures ? 'complete' : successes ? 'partial' : 'failed')) throw new WorkspaceFailure('invalidClipboard');
}

function consumeDiagnostics({ outcomes, pathIssues }: AutomaticReviewGitEvidence, consume: (text: string) => void): void {
  consume('===== REPOPROMPT REVIEW DIFF INCOMPLETE =====\n');
  for (const issue of pathIssues) {
    switch (issue.kind) {
      case 'unresolvedSelection': consume('- Selected path could not be resolved: ' + issue.displayPath + '\n'); break;
      case 'noRepository': consume('- No owning repository: ' + issue.displayPath + '\n'); break;
      case 'invalidGitLayout': consume('- Invalid Git checkout layout: ' + issue.displayPath + '\n'); break;
      case 'unsupportedBackend': consume('- Unsupported repository backend (' + issue.backend + '): ' + issue.displayPath + '\n'); break;
    }
  }
  for (const outcome of outcomes) {
    if (outcome.kind === 'baseResolutionFailed') consume('- Comparison base could not be resolved for checkout: ' + outcome.checkout.displayLabel + '\n');
    if (outcome.kind === 'commandFailed') consume('- Git diff command failed for checkout: ' + outcome.checkout.displayLabel + '\n');
  }
  consume('===== END REPOPROMPT REVIEW DIFF INCOMPLETE =====');
}

function consumeSections(evidence: AutomaticReviewGitEvidence, consume: (text: string) => void, body: (span: Span) => void): void {
  const { outcomes, completeness } = evidence;
  const diffs = outcomes.filter(outcome => outcome.kind === 'diff');
  if (completeness === 'complete' && outcomes.length === 1 && diffs[0]) body(diffs[0].body);
  else {
    for (const [index, diff] of diffs.entries()) {
      if (index) consume('\n\n');
      consume('===== BEGIN REPOPROMPT CHECKOUT DIFF: ' + diff.checkout.displayLabel + ' =====\n');
      body(diff.body);
      consume('\n===== END REPOPROMPT CHECKOUT DIFF: ' + diff.checkout.displayLabel + ' =====');
    }
    if (completeness !== 'complete') {
      if (diffs.length) consume('\n\n');
      consumeDiagnostics(evidence, consume);
    }
  }
}

/** Parses captured RPCE framing and body proofs without generating Git text or consulting native state. */
export function verifyAutomaticReviewGitCapture(capture: AutomaticReviewGitCapture | null, required: boolean): void {
  const invalid = () => { throw new WorkspaceFailure('invalidClipboard'); };
  if (capture === null) { if (required) invalid(); return; }
  if (!required) invalid();
  verifyCompleteness(capture.evidence);
  const bytes = Buffer.from(capture.text ?? '');
  let cursor = 0;
  const consume = (text: string) => {
    const expected = Buffer.from(text);
    if (!bytes.subarray(cursor, cursor + expected.length).equals(expected)) invalid();
    cursor += expected.length;
  };
  const body = (span: Span) => {
    const text = bytes.subarray(cursor, cursor + span.length);
    if (span.offset !== cursor || text.length !== span.length || sha256(text) !== span.sha256) invalid();
    cursor += span.length;
  };
  consumeSections(capture.evidence, consume, body);
  if (cursor !== bytes.length || (bytes.length === 0) !== (capture.text === null)) invalid();
}

function completeRootContainsDeclaration(binding: AutomaticReviewGitEvidence['rootBinding'], checkoutRoot: string,
  declared: InventorySnapshot['roots'][number], normalizedDeclaredPath: string): boolean {
  if (binding === null) return false;
  const parent = binding.kind === 'worktree' ? checkoutRoot : binding.path;
  const path = binding.kind === 'worktree' ? normalizedDeclaredPath : declared.identity.canonicalPath;
  return contains(parent.normalize('NFC'), path.normalize('NFC'));
}

/** Each checkout path must belong to the captured full/slice scope; path failures account for unresolved members. */
export function verifyAutomaticReviewGitSelection(capture: AutomaticReviewGitCapture | null,
  inventory: Omit<InventorySnapshot, 'generation'>, selections: readonly SourceSelection[], request: CapturedContextBuildRequest): void {
  if (capture === null) return;
  const roots = new Map(capture.evidence.sourceRoots.map(root => [root.root, root.path]));
  if (roots.size !== capture.evidence.sourceRoots.length || roots.size !== inventory.roots.length ||
    inventory.roots.some(root => !roots.has(root.name))) throw new WorkspaceFailure('invalidClipboard');
  if (capture.evidence.scope === 'complete') {
    const preset = request.copyContext;
    if (capture.evidence.pathIssues.length || capture.evidence.completeness !== 'complete' ||
      (preset.activeGitRoot === null) !== (capture.evidence.rootBinding === null) ||
      preset.activeGitRoot !== null && !roots.has(preset.activeGitRoot) ||
      capture.evidence.outcomes.length !== (preset.activeGitRoot === null ? 0 : 1) || capture.evidence.outcomes.some(outcome =>
        outcome.checkout.identity.root !== preset.activeGitRoot || outcome.checkout.selectedPaths.length ||
        !completeRootContainsDeclaration(capture.evidence.rootBinding, outcome.checkout.identity.checkoutRootPath,
          inventory.roots.find(root => root.name === outcome.checkout.identity.root)!, roots.get(outcome.checkout.identity.root)!))) throw new WorkspaceFailure('invalidClipboard');
    return;
  }
  if (capture.evidence.rootBinding !== null) throw new WorkspaceFailure('invalidClipboard');
  const remaining = new Set(selections.filter(selection => selection.kind !== 'codemap')
    .map(selection => posix.join(roots.get(selection.source.root)!, selection.source.path).normalize('NFC')));
  for (const outcome of capture.evidence.outcomes) {
    if (!outcome.checkout.selectedPaths.length) throw new WorkspaceFailure('invalidClipboard');
    for (const path of outcome.checkout.selectedPaths) {
      if (!contains(outcome.checkout.identity.checkoutRootPath.normalize('NFC'), path.normalize('NFC')) ||
        !remaining.delete(path.normalize('NFC'))) throw new WorkspaceFailure('invalidClipboard');
    }
  }
  if (remaining.size > capture.evidence.pathIssues.length) throw new WorkspaceFailure('invalidClipboard');
}
