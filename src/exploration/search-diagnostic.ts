import type { SearchDiagnostic } from '../contracts/search-pattern.js';

/** A query-wide expected pattern failure, distinct from a file's scanner diagnostic. */
export class SearchPatternFailure extends Error {
  constructor(readonly diagnostic: SearchDiagnostic) {
    super(diagnostic.kind === 'pattern' ? diagnostic.issue : diagnostic.message);
  }
}
