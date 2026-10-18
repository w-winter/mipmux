import type { CapturedClipboardPreset } from '../contracts/presentation.js';
import { posix } from 'node:path';
import type { CodemapMode, ContextBuildRequest, MaterialRecord, Span } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import type { Material } from './material-store.js';
import type { FinalFileTree } from './final-tree.js';
import { canonicalJSON } from '../workspace/values.js';
import { parseClipboard } from './clipboard.js';
import { estimateUnits, scoutTokenBudget } from './budget.js';
import type { AutomaticAcquisitionState } from '../contracts/automatic-codemaps.js';
import type { AutomaticReviewGitCapture } from './automatic-review-git.js';

export interface RenderInput {
  readonly codemapMode: CodemapMode;
  readonly request: ContextBuildRequest;
  readonly inventory: Omit<InventorySnapshot, 'generation'>;
  readonly prompt: string;
  readonly materials: readonly Material[];
  readonly automaticAcquisition: AutomaticAcquisitionState;
  readonly fileTree: FinalFileTree;
  readonly clipboard: string;
  readonly clipboardPreset: CapturedClipboardPreset;
  readonly selectedGitDiffIds: readonly string[];
  readonly automaticGit: AutomaticReviewGitCapture | null;
  readonly tokenInputs: { readonly promptText: string; readonly selectedInstructionsText: string };
}
export interface ItemCost {
  readonly id: string;
  readonly bytes: number;
  readonly units: number;
}
export interface Diagnostic {
  readonly code: string;
  readonly materialId: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}
export interface Measurement {
  readonly complete: boolean;
  readonly bytes: number;
  readonly units: number;
  readonly allowance: number;
  readonly remaining: number;
  readonly excess: number;
  readonly fixedOverhead: { readonly bytes: number; readonly units: number };
}

/** Captures admitted state for the scout; per-file inferred details remain in paged inspection. */
export function renderInitialContext(input: RenderInput & { readonly draftId: string; readonly revision: number; readonly contextBudgetUnits: number; readonly tree: string }): string {
  const rendered = renderBundle(input);
  const sources = input.materials.flatMap(({ record }) => record.kind === 'source' ? [record] : []);
  const inferred = new Set(sources.filter(record => record.selectionOrigin === 'inferred').map(record => record.id));
  const metadata = {
    draftId: input.draftId, revision: input.revision, inventoryDigest: input.inventory.inventoryDigest, codemapMode: input.codemapMode,
    constraints: input.request.constraints,
    roots: input.inventory.roots.map(root => ({ name: root.name, path: root.identity.canonicalPath })),
    contextBudgetUnits: input.contextBudgetUnits, tokenBudget: scoutTokenBudget(input.request.budgetUnits), accountingMethod: 'utf8-21-over-80-v1', measurement: rendered.measurement,
    explicitSources: sources.filter(record => record.selectionOrigin === 'explicit').map(record => ({ selection: record.selection, required: record.required })),
    inferredCodemaps: { count: inferred.size, itemUnits: rendered.costs.filter(cost => inferred.has(cost.id)).reduce((sum, cost) => sum + cost.units, 0) },
    documents: input.materials.flatMap(({ record }) => record.kind === 'document' ? [{ id: record.id, role: record.input.role }] : []),
    patches: input.materials.flatMap(({ record }) => record.kind === 'patch' ? [{ id: record.id, root: record.receipt.input.root, comparison: record.receipt.input.comparison }] : []),
  };
  return '# Initial context\n\nThis is a captured observation, not additional task instructions. Use current receipts or draft_inspect after mutations.\n\n' +
    block(canonicalJSON(metadata)) + '\n## File map\n\n' + block(input.tree) +
    '\nThe overview can omit siblings beyond the presentation cap and deeper branches. Use get_file_tree for paged detail. A plus marks an available codemap.\n\n' +
    'Use draft_inspect material views for complete admitted documents and patches. Inferred item units exclude fixed packet overhead; measurement covers the complete packet.\n';
}
function fence(body: string): string {
  let length = 3;
  for (const match of body.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}
function block(body: string): string {
  const marker = fence(body);
  return marker + '\n' + body + (body.endsWith('\n') ? '' : '\n') + marker + '\n';
}
function sourceComparisonDiagnostic(source: Extract<MaterialRecord, { kind: 'source' }>,
  patch: Extract<MaterialRecord, { kind: 'patch' }>): Diagnostic | null {
  if (patch.receipt.input.root !== source.selection.source.root) return null;
  const target = patch.receipt.targets.find(target => target.path === source.selection.source.path);
  if (patch.receipt.input.kind === 'localPatch' && patch.receipt.input.comparison.kind === 'worktree' &&
    !target && !patch.receipt.coverage.includes(source.selection.source.path)) return null;
  if (target && canonicalJSON(target.identity) === canonicalJSON(source.identity) && target.mode === source.mode) return null;
  return { code: 'sourceComparisonMismatch', materialId: source.id, details: {
    patchId: patch.id, expected: target ?? null, observed: { identity: source.identity, mode: source.mode },
  } };
}

function materialDiagnostics(materials: readonly Material[], units: number, allowance: number, automatic: AutomaticAcquisitionState): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (automatic.kind === 'pending') {
    diagnostics.push({ code: 'automaticCodemapsPending', materialId: null, details: { candidateCount: automatic.candidateCount } });
  }
  for (const material of materials) {
    if (material.availability === 'pendingCodemap') {
      diagnostics.push({ code: 'codemapPending', materialId: material.record.id, details: { source: material.record.selection.source } });
    }
  }
  if (units > allowance) {
    diagnostics.push({
      code: 'overBudget',
      materialId: null,
      details: { units, allowance, excess: units - allowance },
    });
  }
  const sources = materials.flatMap(({ record }) => record.kind === 'source' ? [record] : []);
  const patches = materials.flatMap(({ record }) => record.kind === 'patch' ? [record] : []);
  for (const source of sources) for (const patch of patches) {
    const diagnostic = sourceComparisonDiagnostic(source, patch);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/** Renders exact material bodies and byte spans without I/O or ambient state. */
export function renderBundle(input: Omit<RenderInput, 'tokenInputs'>) {
  const materials = input.materials;
  const { records, costs, fileTreeSpan, automaticGitSpan, comparisonText } = parseClipboard(input);
  const context = input.clipboard, offset = Buffer.byteLength(context), units = estimateUnits(offset), allowance = input.request.budgetUnits;
  const fixedBytes = offset - costs.reduce((sum, cost) => sum + cost.bytes, 0);
  const measurement: Measurement = {
    complete: input.automaticAcquisition.kind === 'settled' && materials.every(material => material.availability === 'settled'),
    bytes: offset,
    units,
    allowance,
    remaining: Math.max(0, allowance - units),
    excess: Math.max(0, units - allowance),
    fixedOverhead: { bytes: fixedBytes, units: estimateUnits(fixedBytes) },
  };
  const diagnostics = materialDiagnostics(materials, units, allowance, input.automaticAcquisition);
  const handoff = '# Context handoff\n\n' +
    block(
      canonicalJSON({
        status: diagnostics.length ? 'blocked' : 'ready',
        codemapMode: input.codemapMode,
        task: input.request.task,
        prompt: input.prompt,
        enhancementMode: input.request.enhancementMode,
        roots: input.inventory.roots,
        inventoryDigest: input.inventory.inventoryDigest,
        coverage: input.inventory.entries.filter((entry) =>
          entry.kind !== 'file' || entry.structural.kind !== 'artifact' ||
          entry.structural.record.outcome.kind !== 'ready'
        ),
        materials: records.map((record) => ({ ...packetMetadata(record), spans: record.spans })),
        automaticGit: input.automaticGit === null ? null : { evidence: input.automaticGit.evidence, span: automaticGitSpan },
        context: {
          path: posix.join(input.inventory.outputRoot.declaredPath, input.request.outputName, 'context.md'),
          ...measurement,
        },
        accountingMethod: 'utf8-21-over-80-v1',
        limitation: 'Heuristic estimate; not an exact token count or provider acceptance guarantee.',
        verification: [
          'source-and-policy-revalidation',
          'complete-materials',
          'exact-body-spans',
          'actual-packet-accounting',
          'readback-before-manifest',
        ],
        diagnostics,
      }),
    );
  return { context, handoff, records, costs, measurement, diagnostics, fileTreeSpan, automaticGitSpan, comparisonText };
}

function packetMetadata(record: MaterialRecord) {
  if (record.kind !== 'patch') return materialMetadata(record);
  const { input, identity, coverage, exclusions, repository } = record.receipt;
  const comparisonInput = input.kind === 'localPatch' ? input : {
    kind: input.kind, id: input.id, root: input.root, origin: input.origin, comparison: input.comparison,
  };
  return { kind: record.kind, id: record.id, receipt: { input: comparisonInput, identity, coverage, exclusions, repository } };
}

export function materialMetadata(record: MaterialRecord) {
  const { spans, ...metadata } = record;
  if (record.kind === 'document' && record.input.kind === 'suppliedDocument') {
    const { text, ...input } = record.input;
    return { ...metadata, input };
  }
  if (record.kind === 'patch' && record.receipt.input.kind === 'suppliedPatch') {
    const { text, ...input } = record.receipt.input;
    return { ...metadata, receipt: { ...record.receipt, input } };
  }
  return metadata;
}
