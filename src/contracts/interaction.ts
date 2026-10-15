import Type, { type Static } from 'typebox';
import { SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
export const defaultQuestionTimeoutSeconds = 300;
export const Clarification = Type.Object({ questionTimeoutSeconds: Type.Optional(
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, closed);
export const AskUserRequest = Type.Object({ title: Type.Optional(Type.String()), context: Type.Optional(Type.String()),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  questions: Type.Array(Type.Object({ id: Type.String(), question: Type.String(), header: Type.Optional(Type.String()),
    context: Type.Optional(Type.String()), options: Type.Optional(Type.Array(Type.Union([Type.String(),
      Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }, closed)]))),
    allows_multiple: Type.Optional(Type.Boolean()), allows_custom: Type.Optional(Type.Boolean()),
  }, closed)),
}, closed);
export type AskUserRequest = Static<typeof AskUserRequest>;
export const ClientQuestionResponse = Type.Union([
  Type.Object({ action: Type.Literal('accept'), content: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
  Type.Object({ action: Type.Enum(['decline', 'cancel']) }),
]);
export type ClientQuestionResponse = Static<typeof ClientQuestionResponse>;
const payload = Type.Record(Type.String(), Type.Unknown());
const argumentsFields = { payload, defaultTimeoutSeconds: SafeCount };
export const NativeAskUserInput = Type.Union([
  Type.Object({ kind: Type.Literal('prepareAskUser'), ...argumentsFields }, closed),
  Type.Object({ kind: Type.Literal('answerAskUser'), ...argumentsFields,
    action: Type.Enum(['accept', 'decline', 'timeout']), content: payload, elapsedSeconds: SafeCount }, closed),
]);
const text = { type: Type.Literal('string'), enum: Type.Optional(Type.Array(Type.String())) };
const property = { title: Type.String(), description: Type.String() };
const questionProperty = Type.Union([
  Type.Object({ ...property, ...text }, closed),
  Type.Object({ ...property, type: Type.Literal('array'), items: Type.Object(text, closed), uniqueItems: Type.Literal(true) }, closed),
]);
const questionFields = Type.Array(Type.Object({ id: Type.String(), optionLabels: Type.Array(Type.String()), property: questionProperty }, closed));
export const AskUserForm = Type.Object({ type: Type.Literal('object'), title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()), required: Type.Optional(Type.Array(Type.String())),
  properties: Type.Record(Type.String(), questionProperty),
}, closed);
export interface PendingQuestion {
  readonly id: string;
  readonly message: string;
  readonly requestedSchema: Static<typeof AskUserForm>;
  readonly fields: Static<typeof questionFields>;
}
export const AskUserResponse = Type.Object({ answers: Type.Record(Type.String(), Type.Object({
  answers: Type.Array(Type.String()), selected_options: Type.Array(Type.String()),
  custom_response: Type.Union([Type.String(), Type.Null()]), skipped: Type.Boolean(),
}, closed)), timed_out: Type.Boolean(), skipped: Type.Boolean(), elapsed_seconds: SafeCount,
  response: Type.Optional(Type.Union([Type.String(), Type.Null()])),
}, closed);
export const NativeAskUserResult = Type.Union([
  Type.Object({ kind: Type.Literal('askUserPrepared'), message: Type.String(), timeoutSeconds: SafeCount,
    requestedSchema: AskUserForm, fields: questionFields }, closed),
  Type.Object({ kind: Type.Literal('askUserAnswered'), response: AskUserResponse }, closed),
  Type.Object({ kind: Type.Literal('askUserInvalid'), message: Type.String() }, closed),
]);

export const askUserDescription = `Ask the user a clarifying question and wait for their response.

Use this tool to gather additional context or clarification from the user.
The tool will block until the user responds.

**When to use:**
- Task requirements are ambiguous
- Multiple valid approaches exist and you need user preference
- Critical context is missing
- Confirming before making significant changes

**Best practices:**
- Ask early, not at the end
- Be specific - explain what you're trying to determine
- Provide options when the choices are clear
- Limit questions to avoid disrupting the user

**Input:**
- \`questions\`: Required array of structured questions. Each question requires stable \`id\` and \`question\` fields. Use \`allows_multiple\` and \`allows_custom\` for selection/custom-answer behavior.
- \`title\`: Optional title for the form.
- \`context\`: Optional overall context shown above the questions.
- \`timeout_seconds\`: Optional timeout in seconds for the whole interaction. Defaults to the build's question timeout.

**Response:**
- \`answers\`: Object keyed by question ID. Each value contains \`answers\`, \`selected_options\`, \`custom_response\`, and \`skipped\`.
- \`timed_out\`: True if the interaction timed out.
- \`skipped\`: True if user explicitly skipped the interaction.
- \`elapsed_seconds\`: How long the user took to respond.`;
