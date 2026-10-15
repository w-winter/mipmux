import type { SelectionRequest } from '../contracts/selection.js';
import type { NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from '../workspace/workspace-operation.js';
import type { CatalogedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { readAuthorizedGitArtifact } from '../workspace/git-artifact-catalog.js';
import { NativeFailure } from '../native/bridge-client.js';
import { WorkspaceFailure } from '../workspace/values.js';
import { failureCode } from '../runtime/tool-result.js';
import type { Material } from './material-store.js';
import { acquireGitArtifact, type GitArtifactMaterial } from './git-artifact-material.js';

type Parsed = Extract<NativeResult, { kind: 'selectionInputs' }>;
const unavailable = new Set(['gitArtifactNotCataloged', 'gitArtifactUnauthorized', 'gitRepositoryChanged',
  'notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'pathDenied', 'invalidEncoding']);

function isGitArtifactInput(path: string): boolean { return path === '_git_data' || path.startsWith('_git_data/'); }
function validAlias(alias: string): boolean {
  const relative = alias.slice('_git_data/'.length);
  return alias.startsWith('_git_data/') && !!relative && !relative.startsWith('~') && !relative.includes('\0') &&
    relative.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.includes(':'));
}

type AliasResolution = { readonly kind: 'resolved'; readonly material: GitArtifactMaterial }
  | { readonly kind: 'invalid'; readonly diagnostic: string };

function aliasDiagnostic(alias: string, mode: SelectionRequest['mode'], sliceAliases: ReadonlySet<string>): string | null {
  if (!validAlias(alias)) return 'malformed Git artifact alias';
  if (mode !== 'full') return "Git artifacts support mode 'full' only";
  return sliceAliases.has(alias) ? 'Git artifacts do not support slices' : null;
}

async function resolveAlias(operation: WorkspaceOperation, alias: string, use: 'insert' | 'remove',
  selected: ReadonlyMap<string, GitArtifactMaterial>, grants: ReadonlyMap<string, CatalogedGitArtifact>): Promise<AliasResolution> {
  try {
    if (use === 'remove') {
      const material = selected.get(alias);
      if (!material) return { kind: 'invalid', diagnostic: 'alias is not selected' };
      if (!operation.catalogedGitArtifact(material.record.reference.absolutePath)) throw new WorkspaceFailure('gitArtifactNotCataloged');
      await readAuthorizedGitArtifact(operation, material.record.reference);
      return { kind: 'resolved', material };
    }
    const entry = grants.get(alias);
    if (!entry) return { kind: 'invalid', diagnostic: 'alias is not advertised' };
    return { kind: 'resolved', material: await acquireGitArtifact(operation, entry) };
  } catch (error) {
    if (!(error instanceof WorkspaceFailure || error instanceof NativeFailure) || !unavailable.has(error.code)) throw error;
    return { kind: 'invalid', diagnostic: failureCode(error) };
  }
}

export function capturedArtifactSelection(current: ReadonlyMap<string, Material>) {
  const known = new Map<string, GitArtifactMaterial>();
  const selectedAliases = new Map<string, GitArtifactMaterial>();
  for (const material of current.values()) {
    if (material.availability === 'settled' && (material.record.kind === 'gitMap' || material.record.kind === 'gitPatch')) {
      known.set(material.record.reference.absolutePath, { ...material, record: material.record });
      selectedAliases.set(material.record.reference.alias, { ...material, record: material.record });
    }
  }
  return { known, selectedAliases };
}

/** Separates exact artifact aliases from ordinary path resolution; removal uses selected history rather than insertion grants. */
export async function resolveGitArtifactSelection(operation: WorkspaceOperation, request: SelectionRequest, parsed: Parsed,
  current: ReadonlyMap<string, Material>, grants: ReadonlyMap<string, CatalogedGitArtifact>) {
  const { known, selectedAliases } = capturedArtifactSelection(current);
  const resolved: GitArtifactMaterial[] = [], invalid: string[] = [];
  const ordinary = { ...parsed, paths: parsed.paths.filter(path => !isGitArtifactInput(path)),
    slices: parsed.slices.filter(slice => !isGitArtifactInput(slice.path)) };
  if (request.op === 'get' || request.op === 'clear') return { ordinary: parsed, known, resolved, invalid };
  const sliceAliases = new Set(parsed.slices.filter(slice => isGitArtifactInput(slice.path)).map(slice => slice.path));
  const aliases = parsed.paths.filter(isGitArtifactInput);
  if (aliases.length && (request.op === 'promote' || request.op === 'demote')) {
    throw new WorkspaceFailure('invalidSelection', { message: "Git artifact aliases support add, remove, set, and preview in mode 'full' only." });
  }
  for (const alias of aliases) {
    const diagnostic = aliasDiagnostic(alias, request.mode, sliceAliases);
    if (diagnostic !== null) { invalid.push(alias + ': ' + diagnostic); continue; }
    const outcome = await resolveAlias(operation, alias, request.op === 'remove' ? 'remove' : 'insert', selectedAliases, grants);
    if (outcome.kind === 'invalid') { invalid.push(alias + ': ' + outcome.diagnostic); continue; }
    known.set(outcome.material.record.reference.absolutePath, outcome.material);
    resolved.push(outcome.material);
  }
  for (const alias of sliceAliases) if (!aliases.includes(alias)) invalid.push(alias + ': Git artifacts do not support slices');
  return { ordinary, known, resolved, invalid: [...new Set(invalid)] };
}
