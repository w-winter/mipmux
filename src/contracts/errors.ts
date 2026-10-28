import Type, { type Static } from 'typebox';

const wireCodes = [
  'ambiguousGitTopology', 'policyInputDenied', 'policyChanged', 'ignoreControlTooLarge', 'decodeFailed',
  'duplicateRoot', 'rootChanged', 'invalidFilenameEncoding', 'sourceChanged',
  'nonRegularFile', 'invalidOutputCapability', 'invalidRootHandle', 'invalidSourceCapability',
  'invalidExportHandle', 'outputChanged', 'invalidPath', 'publicationUncertain',
  'notFound', 'permissionDenied', 'symlink', 'alreadyExists', 'nativeIOFailed',
  'nativeOperationFailed', 'gitOutputUndecodable',
  'gitRepositoryChanged',
  'unsupportedSnapshotState',
] as const;

export const NativeWireFailureCode = Type.Enum(wireCodes);
export const unreadableFileCodes = ['notFound', 'permissionDenied', 'nonRegularFile', 'symlink', 'nativeIOFailed'] as const;
export const UnreadableFileCode = Type.Enum(unreadableFileCodes);
export type NativeFailureCode = Static<typeof NativeWireFailureCode> |
  'invalidRequest' | 'nativeProtocolError' | 'nativeWorkerFailed' | 'cancelled' | 'nativeWorkerClosed';

/**
 * The nonsecret record that explicit cache invalidation accepts: an artifact key digest, or the workspace key of a
 * membership or reuse record.
 */
export interface CacheRecoveryTarget { readonly kind: 'artifact' | 'membership' | 'reuse'; readonly key: string }
