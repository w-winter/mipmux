import { join } from 'node:path';
import { createCodemodeExtension, createMcpExtension, DefaultResourceLoader, type ExtensionFactory, type SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AdmittedMcp } from './mcp-config.js';
import { WorkspaceFailure } from '../workspace/values.js';

/** The tool the codemode extension registers; it is inactive until the session activates it. */
export const CODEMODE_TOOL = 'codemode';

/**
 * Loads codemode, whose scripts can call only the session's tools and no models, and, when configured, the native MCP
 * factory; server registration applies Pi's semantic validation. No skills, prompt templates, themes, context files or
 * other extensions are loaded.
 */
export async function loadDiscoveryExtensions(mcp: AdmittedMcp | null, settings: SettingsManager) {
  const factories: ExtensionFactory[] = [createCodemodeExtension({ models: false })];
  if (mcp) factories.push(pi => {
    for (const [name, config] of Object.entries(mcp.configuration.mcpServers)) {
      try { pi.registerMcpServer(name, config); }
      catch (cause) { throw Object.defineProperty(new WorkspaceFailure('invalidMcpConfiguration', { server: name }), 'cause', { value: cause }); }
    }
    return createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
      logPath: join(mcp.reference.agentDirectory, 'mcp.log'),
      openUrl: () => { throw new WorkspaceFailure('interactiveSignInRefused'); } })(pi);
  });
  // Discovery sessions run with `/` as their working and agent directory.
  const directory = mcp?.reference.agentDirectory ?? '/';
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
  await loader.reload();
  const extensions = loader.getExtensions();
  if (extensions.errors.length) throw new WorkspaceFailure(mcp ? 'invalidMcpConfiguration' : 'unexpectedExtensionLoad');
  if (extensions.extensions.length !== factories.length) throw new WorkspaceFailure('unexpectedExtensionLoad');
  return extensions;
}
