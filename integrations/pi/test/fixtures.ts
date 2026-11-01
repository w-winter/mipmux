import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomEntry } from '@earendil-works/pi-coding-agent';
import { createMipmux, type MipmuxContext } from '../src/register.ts';
import type { SavedWorkspace, SessionState } from '../src/state.ts';

export const app: SavedWorkspace = { name: 'app', roots: [{ name: 'app', absolutePath: '/repos/app' }],
  outputRoot: '/repos/app/prompt-exports', exclusions: [] };
export const appDeclaration = { roots: app.roots, outputRoot: app.outputRoot, exclusions: [] };

/** A session log entry the extension wrote with `state`. */
export function stateEntry(state: SessionState, id: string): CustomEntry<SessionState> {
  return { type: 'custom', customType: 'mipmux', data: state, id, parentId: null, timestamp: '2026-11-01T00:00:00.000Z' };
}

/** A context recording what the extension shows; it never opens the panel. */
export function context(branch: CustomEntry[] = [], hasUI = true) {
  const statuses: (string | undefined)[] = [], notices: string[] = [];
  const ctx: MipmuxContext = { hasUI, mode: hasUI ? 'tui' : 'print', cwd: '/repos/app', sessionManager: { getBranch: () => branch },
    ui: { setStatus: (_key, text) => { statuses.push(text); }, notify: message => { notices.push(message); },
      custom: () => Promise.reject(new Error('the panel is not used here')) } };
  return { ctx, statuses, notices };
}

/** An extension instance with `saved` in a temporary store; `appended` collects the state entries it writes. */
export async function instance(saved: readonly SavedWorkspace[] = [app]) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mipmux-')), storePath = join(directory, 'mipmux.json');
  await writeFile(storePath, JSON.stringify({ workspaces: saved }));
  const appended: SessionState[] = [];
  const mipmux = createMipmux({ storePath, home: directory, appendEntry: state => { appended.push(state); },
    readConfig: () => Promise.reject(new Error('mipmux config is not used here')) });
  return { mipmux, storePath, appended };
}
