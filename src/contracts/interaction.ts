import Type from 'typebox';
import { SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
const payload = Type.Record(Type.String(), Type.Unknown());
const argumentsFields = { payload, defaultTimeoutSeconds: SafeCount };
export const NativeAskUserInput = Type.Union([
  Type.Object({ kind: Type.Literal('prepareAskUser'), ...argumentsFields }, closed),
  Type.Object({ kind: Type.Literal('answerAskUser'), ...argumentsFields,
    action: Type.Enum(['accept', 'decline', 'timeout']), content: payload, elapsedSeconds: SafeCount }, closed),
]);
const text = { type: Type.Literal('string'), enum: Type.Optional(Type.Array(Type.String())) };
const property = { title: Type.String(), description: Type.String() };
export const AskUserForm = Type.Object({ type: Type.Literal('object'), title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()), required: Type.Optional(Type.Array(Type.String())),
  properties: Type.Record(Type.String(), Type.Union([
    Type.Object({ ...property, ...text }, closed),
    Type.Object({ ...property, type: Type.Literal('array'), items: Type.Object(text, closed), uniqueItems: Type.Literal(true) }, closed),
  ])),
}, closed);
export const AskUserResponse = Type.Object({ answers: Type.Record(Type.String(), Type.Object({
  answers: Type.Array(Type.String()), selected_options: Type.Array(Type.String()),
  custom_response: Type.Union([Type.String(), Type.Null()]), skipped: Type.Boolean(),
}, closed)), timed_out: Type.Boolean(), skipped: Type.Boolean(), elapsed_seconds: SafeCount,
  response: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, closed);
export const NativeAskUserResult = Type.Union([
  Type.Object({ kind: Type.Literal('askUserPrepared'), message: Type.String(), timeoutSeconds: SafeCount, requestedSchema: AskUserForm }, closed),
  Type.Object({ kind: Type.Literal('askUserAnswered'), response: AskUserResponse }, closed),
  Type.Object({ kind: Type.Literal('askUserInvalid'), message: Type.String() }, closed),
]);
