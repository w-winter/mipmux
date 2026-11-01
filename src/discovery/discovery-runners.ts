import type { DiscoveryEvent, DiscoverySelection } from '../contracts/discovery.js';
import { checkRunnerCoverage, claudeCodeProvider } from './discovery-config.js';
import type { ClaudeCodeRunner } from './claude-runner.js';
import type { PiRunner } from './pi-runner.js';
import type { DiscoveryInput, DiscoveryOutcome, DiscoveryRunner, DiscoveryTools } from './runner.js';
import { checkedDefaults, selectDiscovery, type DiscoveryDefaults, type DiscoverySettings } from './selection.js';
import { WorkspaceFailure } from '../workspace/values.js';

/**
 * The host's discovery: the configured and allowed models, and the runner each build's model runs through, Pi for every
 * provider but `claude-code`. Every model the defaults name has a configured runner.
 */
export class DiscoveryRunners implements DiscoveryRunner {
  #defaults: DiscoveryDefaults;
  readonly #pi: PiRunner | null;
  readonly #claudeCode: ClaudeCodeRunner | null;
  constructor(defaults: DiscoveryDefaults, pi: PiRunner | null, claudeCode: ClaudeCodeRunner | null) {
    this.#pi = pi;
    this.#claudeCode = claudeCode;
    this.#defaults = this.#covered(defaults);
  }
  /** The configured model and level and the allowed models that builds started from now on select from. */
  defaults(): DiscoveryDefaults { return this.#defaults; }
  /** Replaces the defaults for builds started from now on; jobs already admitted keep their settings. */
  replaceDefaults(next: DiscoveryDefaults): void { this.#defaults = this.#covered(next); }
  settings(selection: DiscoverySelection | undefined): DiscoverySettings {
    return selectDiscovery(this.#defaults, selection);
  }
  run(input: DiscoveryInput, tools: DiscoveryTools, signal: AbortSignal, progress: (event: DiscoveryEvent) => void,
    settings: DiscoverySettings): Promise<DiscoveryOutcome> {
    const runner = settings.provider === claudeCodeProvider ? this.#claudeCode : this.#pi;
    if (!runner) throw new WorkspaceFailure('invalidDiscoveryConfiguration');
    return runner.run(input, tools, signal, progress, settings);
  }
  /** The `provider/model` references every configured runner can reach, sorted. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const pi = this.#pi ? await this.#pi.listModels(signal) : [];
    const claudeCode = this.#claudeCode ? await this.#claudeCode.listModels(signal) : [];
    return [...pi, ...claudeCode].sort();
  }
  #covered(defaults: DiscoveryDefaults): DiscoveryDefaults {
    const checked = checkedDefaults(defaults);
    checkRunnerCoverage(checked, { pi: this.#pi !== null, claudeCode: this.#claudeCode !== null });
    return checked;
  }
}
