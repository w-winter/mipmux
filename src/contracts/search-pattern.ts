import Type, { type Static } from 'typebox';
import { RelativePath, RootName, SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
export const SearchPatternKind = Type.Enum(['auto', 'literal', 'regex'], { default: 'auto' });
export const SearchMode = Type.Enum(['auto', 'path', 'content', 'both'], { default: 'auto' });
const pattern = Type.Object({ text: Type.String(), isRegex: Type.Boolean(), wholeWord: Type.Boolean() }, closed);
export type PreparedSearchPattern = Static<typeof pattern>;
export const NativeSearchPatternInput = Type.Object({ kind: Type.Literal('prepareSearchPattern'),
  text: Type.String(), queryKind: SearchPatternKind, wholeWord: Type.Boolean(), mode: SearchMode }, closed);
export const NativeSearchPatternResult = Type.Union([
  Type.Object({ kind: Type.Literal('searchPattern'), mode: Type.Enum(['path', 'content', 'both']), path: pattern, content: pattern }, closed),
  Type.Object({ kind: Type.Literal('searchPatternError'), message: Type.String() }, closed),
]);
export const NativeSearchPathsInput = Type.Object({ kind: Type.Literal('matchSearchPaths'),
  pattern: Type.String(), isRegex: Type.Boolean(), caseSensitive: Type.Boolean(),
  mode: Type.Enum(['path', 'content', 'both']),
  limit: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  filters: Type.Object({ extensions: Type.Array(Type.String()), exclude: Type.Array(Type.String()) }, closed),
  files: Type.Array(Type.Object({ root: RootName, path: RelativePath, rootPath: Type.String() }, closed)),
}, closed);
export const NativeSearchPathsResult = Type.Union([
  Type.Object({ kind: Type.Literal('searchPaths'), order: Type.Array(SafeCount), matches: Type.Array(SafeCount),
    excluded: Type.Array(SafeCount) }, closed),
  Type.Object({ kind: Type.Literal('searchPathsError'), message: Type.String() }, closed),
]);
