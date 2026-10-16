import Type, { type Static } from 'typebox';
import { RelativePath, RootName, SafeCount } from './workspace.js';

const closed = { additionalProperties: false };
export const SearchPatternKind = Type.Enum(['auto', 'literal', 'regex'], { default: 'auto' });
export const SearchMode = Type.Enum(['auto', 'path', 'content', 'both'], { default: 'auto' });
const pattern = Type.Object({ text: Type.String(), isRegex: Type.Boolean() }, closed);
export type PreparedSearchPattern = Static<typeof pattern>;
export const NativeSearchPatternInput = Type.Object({ kind: Type.Literal('prepareSearchPattern'),
  text: Type.String(), queryKind: SearchPatternKind, wholeWord: Type.Boolean(), mode: SearchMode }, closed);
export const NativeSearchPatternResult = Type.Union([
  Type.Object({ kind: Type.Literal('searchPattern'), mode: Type.Enum(['path', 'content', 'both']), path: pattern, content: pattern }, closed),
  Type.Object({ kind: Type.Literal('searchContentPatternError'), mode: Type.Enum(['content', 'both']),
    path: pattern, message: Type.String() }, closed),
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
export const NativeLiteralSearchInput = Type.Object({ kind: Type.Literal('scanLiteralLines'),
  text: Type.String(), pattern: Type.String({ minLength: 1 }), caseSensitive: Type.Boolean(), wholeWord: Type.Boolean(),
  countOnly: Type.Boolean(), limit: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
export const NativeLiteralSearchResult = Type.Union([Type.Object({ kind: Type.Literal('literalSearch'),
  matchingLines: SafeCount, matches: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}, closed), Type.Object({ kind: Type.Literal('literalSearchError'), message: Type.String() }, closed)]);
export const NativeRegexSearchInput = Type.Object({ kind: Type.Literal('scanRegexContent'), text: Type.String(),
  pattern: Type.String(), caseSensitive: Type.Boolean(), wholeWord: Type.Boolean(), countOnly: Type.Boolean(),
  limit: Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
const correction = Type.Union([Type.Object({ kind: Type.Literal('unchanged') }, closed),
  Type.Object({ kind: Type.Literal('corrected'), warning: Type.String() }, closed)]);
export type SearchCorrection = Static<typeof correction>;
export const NativeRegexCompilationInput = Type.Object({ kind: Type.Literal('compileRegexContent'),
  pattern: Type.String(), caseSensitive: Type.Boolean(), wholeWord: Type.Boolean() }, closed);
export const NativeRegexCompilationResult = Type.Union([
  Type.Object({ kind: Type.Literal('regexCompilation'), correction }, closed),
  Type.Object({ kind: Type.Literal('regexSearchError'), message: Type.String() }, closed),
]);
export const NativeSearchRecoveryInput = Type.Object({ kind: Type.Literal('prepareSearchRecovery'),
  pattern: Type.String(), isRegex: Type.Boolean() }, closed);
export const NativeSearchRecoveryResult = Type.Object({ kind: Type.Literal('searchRecovery'),
  attempts: Type.Array(Type.Object({ kind: Type.Enum(['literal', 'compressedRegex', 'normalizedRegex', 'quotedRegex']),
    pattern: Type.String() }, closed)),
  warning: Type.String() }, closed);
const restrictedRootPath = Type.Union([Type.String(), Type.Null()]);
export const NativeSearchScopeInput = Type.Object({ kind: Type.Literal('filterSearchScope'),
  snapshots: Type.Array(Type.Object({ standardizedFullPath: Type.String(), standardizedRelativePath: Type.String(),
    standardizedRootPath: Type.String(), clientDisplayPath: Type.String() }, closed)),
  caseInsensitive: Type.Boolean(), clauses: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal('exactFile'), absPath: Type.String(), relPath: Type.String(), restrictedRootPath }, closed),
    Type.Object({ kind: Type.Literal('exactFolder'), absLower: Type.String(), relLower: Type.String(), restrictedRootPath }, closed),
    Type.Object({ kind: Type.Literal('glob'), pattern: Type.String(), restrictedRootPath }, closed),
    Type.Object({ kind: Type.Literal('prefix'), candidateLower: Type.String() }, closed),
  ])) }, closed);
export const NativeSearchScopeResult = Type.Object({ kind: Type.Literal('searchScopeFiltered'),
  indices: Type.Array(SafeCount), visited: SafeCount, cancelled: Type.Boolean() }, closed);
export const NativeRegexSearchResult = Type.Union([
  Type.Object({ kind: Type.Literal('regexSearch'), matchingLines: SafeCount,
    matches: Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })) }, closed),
  Type.Object({ kind: Type.Literal('regexSearchError'), message: Type.String() }, closed),
]);
