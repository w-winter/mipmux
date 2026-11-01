import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, effectiveValue, emptyPreferences, type CallArgs, type Preferences, type SavedWorkspace, type Selection } from '../src/state.ts';

const workspace: SavedWorkspace = { name: 'app', roots: [{ name: 'app', absolutePath: '/repos/app' }], outputRoot: '/repos/app/prompt-exports',
  exclusions: [] };
const declaration = { roots: workspace.roots, outputRoot: workspace.outputRoot, exclusions: [] };
const none: Selection = { kind: 'none' };
const found: Selection = { kind: 'found', workspace };

function build(fields: CallArgs = {}): CallArgs {
  return { workspace: structuredClone(declaration), purpose: 'planning', task: 'Plan', outputName: 'run-1', ...fields };
}

test('precedence runs session pin, workspace pin, agent, session, workspace, global', () => {
  const session = { value: 'session', pinned: false }, sessionPin = { value: 'session', pinned: true };
  const saved = { value: 'workspace', pinned: false }, savedPin = { value: 'workspace', pinned: true };
  assert.deepEqual(effectiveValue(sessionPin, savedPin, 'agent'), { value: 'session', source: 'session-pin' });
  assert.deepEqual(effectiveValue(session, savedPin, 'agent'), { value: 'workspace', source: 'workspace-pin' });
  assert.deepEqual(effectiveValue(session, saved, 'agent'), { value: 'agent', source: 'agent' });
  assert.deepEqual(effectiveValue(session, saved, undefined), { value: 'session', source: 'session' });
  assert.deepEqual(effectiveValue(undefined, saved, undefined), { value: 'workspace', source: 'workspace' });
  assert.deepEqual(effectiveValue(undefined, undefined, undefined), { value: undefined, source: 'global' });
});

test('a build receives session and saved-workspace preferences, and pins override the agent', () => {
  const preferences: Preferences = { budgetUnits: { value: 150000, pinned: true }, enhancementMode: { value: 'preserve', pinned: false },
    thinking: { value: 'low', pinned: false } };
  const pinnedModel: Selection = { kind: 'found', workspace: { ...workspace, model: { value: 'anthropic/claude-haiku-4-5', pinned: true } } };
  const args = build({ budgetUnits: 90000, enhancementMode: 'augment', discovery: { model: 'openai/gpt-x' } });
  assert.deepEqual(decide('context_builder', args, pinnedModel, preferences, true), { kind: 'allowed', changed: true });
  assert.deepEqual(args, build({ budgetUnits: 150000, enhancementMode: 'augment',
    discovery: { model: 'anthropic/claude-haiku-4-5', thinking: 'low' } }));

  const unpinned = build();
  decide('context_builder', unpinned, found, { budgetUnits: { value: 150000, pinned: false } }, true);
  assert.equal(unpinned.budgetUnits, 150000);
  const agentWins = build({ budgetUnits: 90000 });
  assert.deepEqual(decide('context_builder', agentWins, found, { budgetUnits: { value: 150000, pinned: false } }, true),
    { kind: 'allowed', changed: false });
  assert.equal(agentWins.budgetUnits, 90000);
  // Clearing a preference removes it, so the server's global default applies again.
  const cleared = build();
  assert.deepEqual(decide('context_builder', cleared, found, emptyPreferences, true), { kind: 'allowed', changed: false });
  assert.deepEqual(cleared, build());
});

test('clarification applies only with a UI, and a disabled preference removes the agent value only when pinned', () => {
  const enabled: Preferences = { clarification: { value: { enabled: true, questionTimeoutSeconds: 120 }, pinned: false } };
  const withUI = build();
  decide('context_builder', withUI, none, enabled, true);
  assert.deepEqual(withUI.clarification, { questionTimeoutSeconds: 120 });
  const withoutUI = build();
  assert.deepEqual(decide('context_builder', withoutUI, none, enabled, false), { kind: 'allowed', changed: false });
  assert.equal(withoutUI.clarification, undefined);
  const disabledPin: Preferences = { clarification: { value: { enabled: false }, pinned: true } };
  const asked = build({ clarification: {} });
  decide('context_builder', asked, none, disabledPin, true);
  assert.equal('clarification' in asked, false);
  const disabled: Preferences = { clarification: { value: { enabled: false }, pinned: false } };
  const agentAsks = build({ clarification: {} });
  decide('context_builder', agentAsks, none, disabled, true);
  assert.deepEqual(agentAsks.clarification, {});
});

test('a preparation receives only a pinned budget', () => {
  const preferences: Preferences = { budgetUnits: { value: 150000, pinned: false }, enhancementMode: { value: 'preserve', pinned: true },
    model: { value: 'anthropic/claude-haiku-4-5', pinned: true }, clarification: { value: { enabled: true }, pinned: true } };
  const prepare = (fields: CallArgs = {}): CallArgs => ({ workspace: structuredClone(declaration), bundle: 'run-1', prompt: 'Final',
    outputName: 'run-1-final', ...fields });
  const unpinned = prepare();
  assert.deepEqual(decide('context_prepare', unpinned, found, preferences, true), { kind: 'allowed', changed: false });
  assert.deepEqual(unpinned, prepare());
  const pinned = prepare({ budgetUnits: 90000 });
  decide('context_prepare', pinned, found, { ...preferences, budgetUnits: { value: 150000, pinned: true } }, true);
  assert.deepEqual(pinned, prepare({ budgetUnits: 150000 }));
});

test('applying the rules twice changes nothing the second time', () => {
  const preferences: Preferences = { budgetUnits: { value: 150000, pinned: false }, enhancementMode: { value: 'preserve', pinned: true },
    clarification: { value: { enabled: true }, pinned: false }, model: { value: 'anthropic/claude-haiku-4-5', pinned: false },
    thinking: { value: 'high', pinned: true } };
  const args = build({ enhancementMode: 'augment' });
  assert.deepEqual(decide('context_builder', args, found, preferences, true), { kind: 'allowed', changed: true });
  const once = structuredClone(args);
  assert.deepEqual(decide('context_builder', args, found, preferences, true), { kind: 'allowed', changed: false });
  assert.deepEqual(args, once);
});

test('with a workspace selected, a call naming any other workspace is blocked, and a missing selection blocks every call', () => {
  for (const other of [{ ...declaration, outputRoot: '/repos/app/other' },
    { ...declaration, roots: [{ name: 'main', absolutePath: '/repos/app' }] },
    { ...declaration, exclusions: [{ kind: 'prefix', root: 'app', path: 'vendor' }] }]) {
    const args = build({ workspace: other });
    const decision = decide('context_builder', args, found, emptyPreferences, true);
    assert(decision.kind === 'blocked');
    assert.match(decision.reason, /"app"/); assert.match(decision.reason, /Change the selection with \/mipmux\./);
    assert(decision.reason.includes(JSON.stringify(declaration)), decision.reason);
  }
  // An omitted exclusion list is the empty list the saved workspace records.
  const omitted = build({ workspace: { roots: declaration.roots, outputRoot: declaration.outputRoot } });
  assert.equal(decide('context_prepare', omitted, found, emptyPreferences, true).kind, 'allowed');
  const missing = decide('context_builder', build(), { kind: 'missing', name: 'gone', saved: ['app', 'docs'] }, emptyPreferences, true);
  assert(missing.kind === 'blocked'); assert.match(missing.reason, /"gone"/); assert.match(missing.reason, /app, docs/);
  const unreadable = decide('context_builder', build(), { kind: 'unreadable', name: 'app',
    message: '/agent/mipmux.json: /workspaces/0/name must not be empty' },
    emptyPreferences, true);
  assert(unreadable.kind === 'blocked'); assert.match(unreadable.reason, /mipmux\.json/);
  // With nothing selected, any declaration passes through unchanged.
  const unselected = build({ workspace: { roots: [{ name: 'x', absolutePath: '/x' }], outputRoot: '/x/out' } });
  assert.deepEqual(decide('context_builder', unselected, none, emptyPreferences, true), { kind: 'allowed', changed: false });
});
