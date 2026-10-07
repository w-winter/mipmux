import { join } from 'node:path';
import { createMcpExtension, DefaultResourceLoader, type SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AdmittedMcp } from './mcp-config.js';
import { WorkspaceFailure } from '../workspace/values.js';

/** Loads only the native MCP factory; server registration applies Pi's semantic validation. */
export async function loadDiscoveryMcp(mcp: AdmittedMcp, settings: SettingsManager) {
  const directory = mcp.reference.agentDirectory;
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      for (const [name, config] of Object.entries(mcp.configuration.mcpServers)) {
        try { pi.registerMcpServer(name, config); }
        catch (cause) { throw Object.defineProperty(new WorkspaceFailure('invalidMcpConfiguration', { server: name }), 'cause', { value: cause }); }
      }
      return createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
        logPath: join(directory, 'mcp.log'),
        openUrl: () => { throw new WorkspaceFailure('interactiveSignInRefused'); } })(pi);
    }] });
  await loader.reload();
  const extensions = loader.getExtensions();
  if (extensions.errors.length) throw new WorkspaceFailure('invalidMcpConfiguration');
  if (extensions.extensions.length !== 1) throw new WorkspaceFailure('unexpectedExtensionLoad');
  return extensions;
}
