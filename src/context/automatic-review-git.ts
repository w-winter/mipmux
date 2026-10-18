// Ported from RepoPrompt CE 43a9c29d3894e4841d8cca4c75b45f7a68b3ecb3; see docs/vendor-provenance.json.
import type { AutomaticReviewGitEvidence, ContextBuildRequest, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { NativeOperation, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { Material } from './material-store.js';
import { selectedGitSourcePaths } from './git-target.js';
import { resolveDiffRepository, gitText } from '../exploration/git-repository.js';
import { prepareGitDiffComparison, capturePreparedGitDiff } from '../exploration/git-diff.js';
import { resolveGitCommit } from '../patches/local-git.js';
import { gitProcess } from '../patches/git-process.js';
import { canonicalJSON, freeze, sha256, WorkspaceFailure } from '../workspace/values.js';
import { capturedSourceSelections } from './source-omissions.js';

export interface AutomaticReviewGitCapture {
  readonly evidence: AutomaticReviewGitEvidence;
  readonly text: string | null;
}
export type AutomaticReviewGitSource =
  | { readonly kind: 'live'; readonly operation: WorkspaceOperation }
  | { readonly kind: 'captured'; readonly capture: AutomaticReviewGitCapture | null };

type Outcome = Extract<NativeOperation, { kind: 'renderAutomaticReviewGit' }>['outcomes'][number];
type Checkout = Outcome['checkout'];
type Owner = Awaited<ReturnType<typeof resolveDiffRepository>>;
type Commands = Extract<NativeResult, { kind: 'gitDiffArguments' }>;
type Comparison = { readonly head: string; readonly base: string };
type Plan =
  | { readonly kind: 'ready'; readonly checkout: Checkout; readonly owner: Owner; readonly commands: Commands; readonly comparison: Comparison }
  | { readonly kind: 'baseResolutionFailed'; readonly checkout: Checkout };

// Only these Git failures become partial diagnostics; security, worker and cancellation failures reject.
const operationalFailures = new Set(['gitQueryFailed', 'gitFailed', 'gitProtocolError', 'gitOutputUndecodable', 'gitComparisonUnavailable']);

function diffRequest(root: string, base: string) {
  return { op: 'diff' as const, root, worktree: null, compare: 'uncommitted:' + base, path: null, paths: [],
    contextLines: 3, detectRenames: false, detail: 'full', artifacts: false as const,
    // The internal capture API does not project a reply or apply this transport allowance.
    maxOutputBytes: Number.MAX_SAFE_INTEGER };
}

/** Resolves every checkout boundary before the first working-tree capture, matching RPCE's discover coordinator. */
export async function acquireAutomaticReviewGit(operation: WorkspaceOperation, request: ContextBuildRequest,
  materials: readonly Material[], unavailableRoots: readonly UnavailableRoot[], unavailableFiles: readonly UnavailableFile[]): Promise<AutomaticReviewGitCapture> {
  const unavailable = new Set(unavailableRoots.map(root => root.root));
  const roots = new Map(operation.snapshot.roots.map(root => [root.name, root.identity.canonicalPath]));
  const catalog = new Set(operation.snapshot.entries.flatMap(entry => entry.kind === 'file' && !unavailable.has(entry.root)
    ? [roots.get(entry.root)! + '/' + entry.path] : []));
  const paths = selectedGitSourcePaths(operation, capturedSourceSelections(materials, unavailableRoots, unavailableFiles));
  return acquireSelectedReviewGit(operation, request, { paths: paths.filter(path => catalog.has(path)), unresolvedCandidates: paths.filter(path => !catalog.has(path)) });
}

export async function acquireSelectedReviewGit(operation: WorkspaceOperation, request: ContextBuildRequest,
  selection: { readonly paths: readonly string[]; readonly unresolvedCandidates: readonly string[] }): Promise<AutomaticReviewGitCapture> {
  const ownership = await operation.resolveAutomaticReviewGit(selection, request.reviewGitBase ?? null);
  if (ownership.checkouts.length && !operation.runtime.options.git) throw new WorkspaceFailure('gitNotConfigured');
  const plans: Plan[] = [];
  for (const checkout of ownership.checkouts) {
    operation.signal.throwIfAborted();
    try {
      const repository = await resolveDiffRepository(operation, checkout.identity.root, { kind: 'elected', checkout: checkout.identity });
      const valid = await operation.revalidateGitTargets({ kind: 'revalidateGitTargets', checkouts: [checkout.identity] });
      if (!valid.valid) throw new WorkspaceFailure('gitRepositoryChanged');
      const line = async (args: readonly string[]) => {
        const result = await gitProcess(operation.runtime.supervisor, repository.executable,
          repository.repository.worktree.canonicalPath, args, operation.signal, { kind: 'repository' });
        if (result.code !== 0) throw new WorkspaceFailure('gitQueryFailed', { exit: result.code });
        const text = gitText(result.bytes);
        if (!text.endsWith('\n')) throw new WorkspaceFailure('gitProtocolError');
        return text.slice(0, -1);
      };
      const head = await resolveGitCommit('HEAD', line);
      const base = ownership.base === null ? head : await line(['merge-base', head, await resolveGitCommit(ownership.base, line)]);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) throw new WorkspaceFailure('gitProtocolError');
      const commands = await prepareGitDiffComparison(operation, diffRequest(checkout.identity.root, base), repository);
      plans.push({ kind: 'ready', checkout, owner: repository, commands, comparison: { head, base } });
    } catch (error) {
      operation.signal.throwIfAborted();
      await operation.validateSourceRoot(checkout.identity.root);
      if (!(error instanceof WorkspaceFailure && operationalFailures.has(error.code))) throw error;
      plans.push({ kind: 'baseResolutionFailed', checkout });
    }
  }
  return capturePlans(operation, plans, ownership.pathIssues);
}

async function capturePlans(operation: WorkspaceOperation, plans: readonly Plan[],
  pathIssues: AutomaticReviewGitEvidence['pathIssues']): Promise<AutomaticReviewGitCapture> {
  const outcomes: Outcome[] = [];
  for (const plan of plans) {
    operation.signal.throwIfAborted();
    if (plan.kind === 'baseResolutionFailed') { outcomes.push(plan); continue; }
    try {
      await plan.owner.revalidate();
      const captured = await capturePreparedGitDiff(operation, diffRequest(plan.checkout.identity.root, plan.comparison.base),
        plan.owner, plan.commands, true, plan.checkout.selectedPaths);
      operation.signal.throwIfAborted();
      outcomes.push({ kind: 'diff', checkout: plan.checkout, text: captured.content.diffText ?? '' });
    } catch (error) {
      operation.signal.throwIfAborted();
      await operation.validateSourceRoot(plan.checkout.identity.root);
      if (!(error instanceof WorkspaceFailure && operationalFailures.has(error.code))) throw error;
      outcomes.push({ kind: 'commandFailed', checkout: plan.checkout });
    }
  }
  const result = await operation.runtime.renderPresentation({ kind: 'renderAutomaticReviewGit', outcomes, pathIssues }, operation.signal);
  operation.signal.throwIfAborted();
  let diffIndex = 0;
  const bytes = Buffer.from(result.text ?? '');
  const evidence: AutomaticReviewGitEvidence = { completeness: result.completeness, pathIssues,
    outcomes: result.outcomes.map((outcome, index) => {
      if (outcome.kind === 'baseResolutionFailed') return { kind: outcome.kind, checkout: outcome.checkout };
      const plan = plans[index]!;
      if (plan.kind !== 'ready') throw new WorkspaceFailure('invalidAutomaticGit');
      const common = { checkout: outcome.checkout, comparison: plan.comparison };
      if (outcome.kind !== 'diff') return { ...common, kind: outcome.kind };
      const body = result.bodySpans[diffIndex++]!;
      return { ...common, kind: outcome.kind, body: { ...body, sha256: sha256(bytes.subarray(body.offset, body.offset + body.length)) } };
    }) };
  process.stderr.write(JSON.stringify({ level: 'debug', event: 'automaticReviewGitCaptured', completeness: evidence.completeness,
    checkouts: evidence.outcomes.length, pathIssues: evidence.pathIssues.length }) + '\n');
  return freeze({ evidence, text: result.text });
}

/** Replays working-tree evidence against captured object IDs before the publication claim. */
export async function revalidateCapturedAutomaticReviewGit(operation: WorkspaceOperation, captured: AutomaticReviewGitCapture | null): Promise<void> {
  if (captured === null) return;
  const plans: Plan[] = [];
  for (const outcome of captured.evidence.outcomes) {
    const checkout = outcome.checkout;
    if (outcome.kind === 'baseResolutionFailed') { plans.push(outcome); continue; }
    const owner = await resolveDiffRepository(operation, checkout.identity.root, { kind: 'elected', checkout: checkout.identity });
    const valid = await operation.revalidateGitTargets({ kind: 'revalidateGitTargets', checkouts: [checkout.identity] });
    if (!valid.valid) throw new WorkspaceFailure('gitRepositoryChanged');
    const commands = await prepareGitDiffComparison(operation, diffRequest(checkout.identity.root, outcome.comparison.base), owner);
    plans.push({ kind: 'ready', checkout, owner, commands, comparison: outcome.comparison });
  }
  const current = await capturePlans(operation, plans, captured.evidence.pathIssues);
  if (canonicalJSON(current) !== canonicalJSON(captured)) throw new WorkspaceFailure('automaticGitChanged');
}

export async function revalidateAutomaticReviewGit(operation: WorkspaceOperation, request: ContextBuildRequest,
  materials: readonly Material[], captured: AutomaticReviewGitCapture | null, unavailableRoots: readonly UnavailableRoot[], unavailableFiles: readonly UnavailableFile[]): Promise<void> {
  if (captured === null) return;
  const current = await acquireAutomaticReviewGit(operation, request, materials, unavailableRoots, unavailableFiles);
  if (canonicalJSON(current) !== canonicalJSON(captured)) throw new WorkspaceFailure('automaticGitChanged');
}
