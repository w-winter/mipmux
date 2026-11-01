import type { DiscoverySettings } from '../../src/discovery/selection.js';

/** Discovery settings for a test double runner, which never starts a model. */
export function fixtureSettings(): DiscoverySettings {
  return { provider: 'fixture', model: 'fixture', thinking: 'off' };
}
