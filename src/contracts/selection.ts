import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
export const SelectionRequest = Type.Object({
  op: Type.Enum(['get', 'set', 'add', 'remove', 'preview', 'promote', 'demote', 'clear'], { default: 'get' }),
  mode: Type.Enum(['full', 'slices', 'codemap_only'], { default: 'full' }),
  paths: Type.Array(Type.String(), { default: [] }),
  slices: Type.Unknown({ default: null }),
  strict: Type.Boolean({ default: false }),
  view: Type.Enum(['summary', 'files', 'content', 'codemaps'], { default: 'summary' }),
  path_display: Type.Enum(['relative', 'full'], { default: 'relative' }),
  expectedRevision: Type.Optional(SafeCount),
  maxOutputBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
export type SelectionRequest = Static<typeof SelectionRequest>;
export const SelectionInput = Type.Partial(Type.Omit(SelectionRequest, ['maxOutputBytes']), closed);
export const selectionValidator = Compile(SelectionRequest);
