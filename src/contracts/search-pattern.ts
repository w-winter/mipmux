import Type, { type Static } from 'typebox';

const closed = { additionalProperties: false };
export const SearchPatternKind = Type.Enum(['auto', 'literal', 'regex'], { default: 'auto' });
const pattern = Type.Object({ text: Type.String(), isRegex: Type.Boolean(), wholeWord: Type.Boolean() }, closed);
export type PreparedSearchPattern = Static<typeof pattern>;
export const NativeSearchPatternInput = Type.Object({ kind: Type.Literal('prepareSearchPattern'),
  text: Type.String(), queryKind: SearchPatternKind, wholeWord: Type.Boolean() }, closed);
export const NativeSearchPatternResult = Type.Union([
  Type.Object({ kind: Type.Literal('searchPattern'), path: pattern, content: pattern }, closed),
  Type.Object({ kind: Type.Literal('searchPatternError'), message: Type.String() }, closed),
]);
