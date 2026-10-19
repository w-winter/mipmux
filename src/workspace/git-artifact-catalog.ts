import type { NativeGitCheckout, NativeResult } from '../contracts/native.js';
import type { WorkspaceOperation } from './workspace-operation.js';
import { NativeFailure } from '../native/bridge-client.js';
import { freeze, WorkspaceFailure } from './values.js';
import { failureCode } from '../runtime/tool-result.js';

interface Publication {
  readonly snapshotID: string;
  readonly snapshotDir: string;
  readonly checkout: NativeGitCheckout;
  readonly projection: Extract<NativeResult, { kind: 'gitArtifacts' }>;
}
type Artifact = Extract<NativeResult, { kind: 'gitArtifacts' }>['publishedArtifacts'][number];
export interface CatalogedGitArtifact {
  readonly ownerID: string;
  readonly checkout: NativeGitCheckout;
  readonly snapshotID: string;
  readonly snapshotDir: string;
  readonly artifact: Artifact;
  readonly path: string;
}
const readinessWarningLimit = 20;
const unreadable = new Set(['notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed']);

function decodeText(bytes: string): string {
  const raw = Buffer.from(bytes, 'base64'), text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw)) throw new WorkspaceFailure('invalidEncoding');
  return text;
}

/** Catalogs exact published paths in ingress order; missing manifest registration suppresses every selectable alias. */
export async function registerPublishedGitArtifacts(operation: WorkspaceOperation, published: Publication, ownerID: string) {
  const cataloged = new Map<string, CatalogedGitArtifact>(), warnings: string[] = [];
  for (const artifact of published.projection.publishedArtifacts) {
    operation.signal.throwIfAborted();
    const prefix = published.snapshotDir + '/';
    if (!artifact.gitDataRelativePath.startsWith(prefix)) throw new WorkspaceFailure('nativeProtocolError');
    const entry = freeze({ ownerID, checkout: published.checkout, snapshotID: published.snapshotID,
      snapshotDir: published.snapshotDir, artifact, path: artifact.gitDataRelativePath.slice(prefix.length) });
    try {
      decodeText((await operation.readGitSnapshotFile(entry)).bytes);
      operation.registerGitArtifact(entry);
      cataloged.set(artifact.absolutePath, entry);
    } catch (error) {
      if (!(error instanceof NativeFailure && unreadable.has(error.code)) &&
        !(error instanceof WorkspaceFailure && ['invalidEncoding', 'pathDenied'].includes(error.code))) throw error;
      warnings.push('Git artifact readiness: ' + (artifact.clientAlias ?? artifact.gitDataRelativePath) +
        ' was not selection-ready (' + failureCode(error) + ').');
    }
  }
  const manifest = published.projection.publishedArtifacts.find(artifact => artifact.kind === 'manifest');
  if (!manifest) throw new WorkspaceFailure('nativeProtocolError');
  const ready = cataloged.has(manifest.absolutePath) ? [...cataloged.values()]
    .filter(entry => entry.artifact.selectionDisposition !== 'authorizationDependency') : [];
  const omitted = warnings.length - Math.min(warnings.length, readinessWarningLimit);
  const parts = warnings.slice(0, readinessWarningLimit);
  if (omitted) parts.push('Git artifact readiness: ' + omitted + ' additional failure(s) omitted.');
  process.stderr.write(JSON.stringify({ level: 'info', event: 'gitArtifactCatalogIngressCompleted', ownerID,
    snapshotDir: published.snapshotDir, cataloged: cataloged.size, selectable: ready.length, failures: warnings.length }) + '\n');
  return { ready, warning: parts.length ? parts.join('\n') : null };
}

/** Reads registered historical bytes under current root/checkout authority, without comparing HEAD or working-tree state. */
export async function readCatalogedGitArtifact(operation: WorkspaceOperation, entry: CatalogedGitArtifact) {
  const registered = operation.catalogedGitArtifact(entry.artifact.absolutePath);
  const manifestPath = entry.artifact.absolutePath.slice(0, -entry.path.length) + 'manifest.json';
  if (!registered || !operation.catalogedGitArtifact(manifestPath)) throw new WorkspaceFailure('gitArtifactNotCataloged');
  return readAuthorizedGitArtifact(operation, entry);
}

/** Revalidates a retained artifact reference against current filesystem authority, including current checks of saved bundles. */
export async function readAuthorizedGitArtifact(operation: WorkspaceOperation,
  entry: Pick<CatalogedGitArtifact, 'ownerID' | 'checkout' | 'snapshotID' | 'snapshotDir' | 'path'>) {
  await operation.validateRoots();
  if (!(await operation.revalidateGitTargets({ kind: 'revalidateGitTargets', checkouts: [entry.checkout] })).valid) {
    throw new WorkspaceFailure('gitRepositoryChanged');
  }
  const manifest = await operation.readGitSnapshotFile({ ...entry, path: 'manifest.json' });
  const authorized = await operation.projectNative({ kind: 'authorizeGitArtifact', manifest: manifest.bytes,
    snapshotDir: entry.snapshotDir, path: entry.path, ownerID: entry.ownerID, checkout: entry.checkout });
  if (!authorized.authorized) throw new WorkspaceFailure('gitArtifactUnauthorized');
  const body = await operation.readGitSnapshotFile(entry);
  return { text: decodeText(body.bytes), identity: body.identity };
}
