import Type, { type Static } from 'typebox';

const wireCodes = [
  'duplicateRoot', 'rootChanged', 'invalidFilenameEncoding', 'sourceChanged',
  'nonRegularFile', 'invalidOutputCapability', 'invalidRootHandle', 'invalidSourceCapability',
  'invalidExportHandle', 'outputChanged', 'invalidPath', 'publicationUncertain',
  'notFound', 'permissionDenied', 'symlink', 'alreadyExists', 'nativeIOFailed',
  'nativeOperationFailed', 'gitOutputUndecodable',
] as const;

export const NativeWireFailureCode = Type.Enum(wireCodes);
export type NativeFailureCode = Static<typeof NativeWireFailureCode> |
  'invalidRequest' | 'nativeProtocolError' | 'nativeWorkerFailed' | 'cancelled' | 'nativeWorkerClosed';

/** The nonsecret record that explicit cache invalidation accepts: an artifact key digest or a workspace membership key. */
export interface CacheRecoveryTarget { readonly kind: 'artifact' | 'membership'; readonly key: string }
