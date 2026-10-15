import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SourcePath } from './inventory.js';
import { SourceIdentity } from './workspace.js';
import { ArtifactKey } from './artifact.js';

const acquisitionFailure = Type.Enum(['sourceChanged', 'policyChanged', 'pathDenied', 'decodeFailed', 'binarySource',
  'notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed']);
export const automaticCodemapFailure = Compile(acquisitionFailure);

/** One captured acquisition outcome for each canonical automatic candidate, including unavailable targets. */
export const AutomaticCodemapOutcome = Type.Object({
  source: SourcePath,
  identity: SourceIdentity,
  artifactKey: ArtifactKey,
  outcome: Type.Union([
    Type.Object({ kind: Type.Literal('ready') }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal('unavailable'), cause: acquisitionFailure }, { additionalProperties: false }),
  ]),
}, { additionalProperties: false });
export type AutomaticCodemapOutcome = Static<typeof AutomaticCodemapOutcome>;

/** Pending describes an unresolved observation; only settled outcomes can be archived. */
export type AutomaticAcquisitionState =
  | { readonly kind: 'pending'; readonly candidateCount: number }
  | { readonly kind: 'settled'; readonly outcomes: readonly AutomaticCodemapOutcome[] };
