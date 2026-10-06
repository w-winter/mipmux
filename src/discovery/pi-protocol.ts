import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { Completion, DiscoveryCall, DiscoveryEvent, DiscoveryReceipt, RecoveryPolicy } from '../contracts/discovery.js';

const closed = { additionalProperties: false };
const absolute = Type.String({ pattern: '^/[^\\u0000]*$' });
export const PiConfig = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }),
  thinking: Type.Enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  authPath: absolute, modelsPath: absolute, environment: Type.Record(Type.String(), Type.String()),
  policy: RecoveryPolicy }, closed);
export type PiConfig = Static<typeof PiConfig>;
export const piConfigValidator = Compile(PiConfig);
const scope = { generation: Type.String({ minLength: 1 }), job: Type.String({ minLength: 1 }) };
export const ParentMessage = Type.Union([
  Type.Object({ ...scope, kind: Type.Literal('start'), config: PiConfig,
    input: Type.Object({ task: Type.String(), constraints: Type.String(), hints: Type.Array(Type.String()), roots: Type.Array(Type.String()) }, closed),
    prompt: Type.String() }, closed),
  Type.Object({ ...scope, kind: Type.Literal('abort') }, closed),
  Type.Object({ ...scope, kind: Type.Literal('toolResult'), id: Type.String(), value: Type.Unknown(), failed: Type.Boolean() }, closed),
]);
export type ParentMessage = Static<typeof ParentMessage>;
export const Evidence = Type.Union([
  Type.Object({ kind: Type.Literal('preflight'), effective: DiscoveryReceipt.properties.effective,
    policy: RecoveryPolicy }, closed),
  Type.Object({ kind: Type.Literal('completion'), value: Completion }, closed),
  Type.Object({ kind: Type.Literal('assistant'), value: Completion }, closed),
  Type.Object({ kind: Type.Literal('prompt'), outcome: Type.Enum(['resolved', 'rejected']) }, closed),
  Type.Object({ kind: Type.Literal('lifecycle'), stage: Type.Enum(['accepted', 'settled', 'idle', 'observationsSettled', 'disposed']) }, closed),
]);
export type Evidence = Static<typeof Evidence>;
export const WorkerMessage = Type.Union([
  Type.Object({ ...scope, kind: Type.Literal('evidence'), fact: Evidence }, closed),
  Type.Object({ ...scope, kind: Type.Literal('tool'), id: Type.String(), call: DiscoveryCall }, closed),
  Type.Object({ ...scope, kind: Type.Literal('progress'), event: DiscoveryEvent }, closed),
  Type.Object({ ...scope, kind: Type.Literal('complete'),
    outcome: Type.Enum(['complete', 'failed', 'cancelled']), code: Type.String() }, closed),
]);
export type WorkerMessage = Static<typeof WorkerMessage>;
export const parentValidator = Compile(ParentMessage), workerValidator = Compile(WorkerMessage);
