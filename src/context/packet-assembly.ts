import { performance } from 'node:perf_hooks';
import type { CapturedContextBuildRequest, CodemapMode, UnavailableFile, UnavailableRoot } from '../contracts/context.js';
import type { InventorySnapshot } from '../contracts/inventory.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import { freeze } from '../workspace/values.js';
import type { DerivedMaterials } from './automatic-codemap-acquisition.js';
import { withCodemapPresentation, type CodemapPresentation } from './codemap-readiness.js';
import { prepareRenderInput } from './final-tree.js';
import { refreshGitArtifactMaterials } from './git-artifact-material.js';
import { revalidateCapturedAutomaticReviewGit } from './automatic-review-git.js';
import { revalidateMaterials } from './revalidate.js';
import type { RenderInput } from './render.js';
import type { CanonicalSelection } from './selection-preparation.js';
import { captureUnavailableRoots, packetSources } from './source-omissions.js';

/** Captures assembly progress, including partial state retained when preparation fails. */
export interface PacketCapture {
  presentation: CodemapPresentation;
  inventory: InventorySnapshot;
  unavailableRoots: readonly UnavailableRoot[];
  unavailableFiles: readonly UnavailableFile[];
  renderInput: RenderInput | null;
}

export function initialPacketCapture(inventory: InventorySnapshot, presentation: CodemapPresentation): PacketCapture {
  return { inventory, presentation: { materials: new Map(presentation.materials),
    automaticAcquisition: freeze(presentation.automaticAcquisition) }, unavailableRoots: [], unavailableFiles: [], renderInput: null };
}

interface PacketAssembly {
  readonly request: CapturedContextBuildRequest;
  readonly prompt: string;
  readonly mode: CodemapMode;
  readonly canonical: CanonicalSelection;
  readonly presentation: CodemapPresentation;
  readonly prepare: (operation: WorkspaceOperation, unavailableRoots: ReadonlySet<string>) => Promise<DerivedMaterials>;
}

/** Keeps rendering and owner observations inside the retained presentation. */
export async function assemblePacket<T>(operation: WorkspaceOperation, input: PacketAssembly, capture: PacketCapture,
  complete: (input: RenderInput) => Promise<T>): Promise<T> {
  capture.inventory = operation.snapshot;
  const rootFailures = await captureUnavailableRoots(operation);
  const unavailable = new Set(rootFailures.map(root => root.root));
  const assemble = async (presentation: CodemapPresentation) => {
    const materials = await refreshGitArtifactMaterials(operation, [...presentation.materials.values()]);
    capture.presentation = { materials: new Map(materials.map(material => [material.record.id, material])),
      automaticAcquisition: freeze(presentation.automaticAcquisition) };
    const delivery = await packetSources(operation, materials, rootFailures);
    capture.unavailableRoots = delivery.unavailableRoots;
    capture.unavailableFiles = delivery.unavailableFiles;
    await revalidateMaterials(operation, delivery.materials, delivery.unavailableRoots, delivery.unavailableFiles);
    capture.inventory = operation.snapshot;
    const { generation: _generation, ...inventory } = capture.inventory;
    const prepared = await prepareRenderInput(operation.runtime, { request: input.request, prompt: input.prompt,
      codemapMode: input.mode, materials: delivery.materials, inventory, automaticAcquisition: presentation.automaticAcquisition,
      unavailableRoots: delivery.unavailableRoots, unavailableFiles: delivery.unavailableFiles }, operation.signal,
    { kind: 'live', operation }, input.canonical);
    capture.renderInput = prepared;
    capture.inventory = operation.snapshot;
    return complete(prepared);
  };
  return input.request.copyPreset.codeMapUsage === 'auto'
    ? withCodemapPresentation(operation, input.mode, performance.now(), () => input.prepare(operation, unavailable), assemble)
    : assemble(input.presentation);
}

export async function revalidatePacket(operation: WorkspaceOperation, input: RenderInput): Promise<void> {
  await revalidateMaterials(operation, input.materials, input.unavailableRoots, input.unavailableFiles);
  await revalidateCapturedAutomaticReviewGit(operation, input.automaticGit);
}
