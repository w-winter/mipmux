// Selects the CI jobs that the changes from <base> to <head> need and prints them as GitHub Actions outputs.
// A path that no rule below covers needs the full pipeline, and so does every change whose base lacks a successful CI run.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

const noPreviousCommit = /^0{40}$/u;
// First match wins. Source history runs in every CI run, so the provenance manifest needs no further job. The root
// README.md has no rule because package staging checks its content for the checkout path.
const rules = [
  { lane: 'full', reason: 'a type change is not a content edit', matches: change => change.status === 'T' },
  { lane: 'none', reason: 'checked by Source history in every run', matches: change => change.path === 'docs/vendor-provenance.json' },
  { lane: 'none', reason: 'documentation', matches: change => change.path.startsWith('docs/') && change.path.endsWith('.md') },
  { lane: 'none', reason: 'documentation', matches: change => change.path === 'CHANGELOG.md' || change.path === 'SECURITY.md' },
  // oh-my-pi's staging script copies its README.md, so a deletion falls through to the extension checks.
  { lane: 'none', reason: 'integration documentation',
    matches: change => change.status !== 'D' && /^integrations\/(?:pi|omp)\/(?:README|CHANGELOG)\.md$/u.test(change.path) },
  // omp copies Pi's sources and runs Pi's stand-in server in its tests, so one job checks both extensions.
  { lane: 'extensions', reason: 'Pi and oh-my-pi extension checks', matches: change => /^integrations\/(?:pi|omp)\//u.test(change.path) },
  { lane: 'examples', reason: 'workflow example consistency test', matches: change => change.path.startsWith('workflow-examples/') },
];
const unmatched = { lane: 'full', reason: 'no narrower rule covers this path' };

const report = line => console.error(line);
const quoted = path => JSON.stringify(path);
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: Infinity, stdio: ['ignore', 'pipe', 'pipe'] });

/** The full SHA of `revision`, or null when it names no commit in this checkout. */
function commit(revision) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Every added, modified, deleted or type-changed path; a rename is a deletion plus an addition. */
function changes(base, head) {
  const fields = git(['diff', '--no-renames', '--name-status', '-z', base, head, '--']).split('\0');
  assert.equal(fields.pop(), '', 'git diff output must end with a NUL');
  assert.equal(fields.length % 2, 0, 'git diff output must pair each status with a path');
  const list = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index], path = fields[index + 1];
    assert(['A', 'M', 'D', 'T'].includes(status) && path, `Unexpected git diff record: ${quoted(status)} ${quoted(path)}`);
    list.push({ status, path });
  }
  return list;
}

/** Whether `base` has a successful CI run for a push to main; a missing or unreadable answer counts as no. */
function baseEvidence(base) {
  const query = spawnSync('gh', ['api', '--method', 'GET', 'repos/{owner}/{repo}/actions/workflows/ci.yml/runs',
    '-f', `head_sha=${base}`, '-f', 'event=push', '-f', 'branch=main', '-f', 'per_page=100'], { encoding: 'utf8', maxBuffer: Infinity });
  const unreadable = detail => ({ kind: 'unvalidated', reason: `could not query CI runs for ${base}: ${detail}` });
  if (query.error) return unreadable(query.error.message);
  if (query.status !== 0) return unreadable(query.stderr.trim().split('\n')[0] || `gh exited with ${query.status}`);
  let runs;
  try { runs = JSON.parse(query.stdout).workflow_runs; } catch (error) { return unreadable(error.message); }
  if (!Array.isArray(runs)) return unreadable('the response has no workflow_runs list');
  // Pull-request runs test a merge tree rather than their head commit, so only push runs on main are evidence.
  const success = runs.find(run => run?.head_sha === base && run.event === 'push' && run.head_branch === 'main' &&
    run.status === 'completed' && run.conclusion === 'success');
  if (success) return { kind: 'validated', url: String(success.html_url) };
  if (!runs.length) return { kind: 'unvalidated', reason: `no CI run for a push to main at ${base}` };
  return { kind: 'unvalidated', reason: `no successful CI push run on main at ${base}: ` +
    runs.map(run => `${run?.id} ${run?.head_sha} ${run?.status}/${run?.conclusion}`).join(', ') };
}

function decide(baseRevision, head) {
  if (noPreviousCommit.test(baseRevision)) return { kind: 'full', reasons: ['the push has no previous commit'] };
  const base = commit(baseRevision);
  if (!base) return { kind: 'full', reasons: [`base commit ${baseRevision} is not available in this checkout`] };
  report(`Comparing base ${base} with head ${head}`);
  const lanes = new Set(), reasons = [];
  for (const change of changes(base, head)) {
    const rule = rules.find(candidate => candidate.matches(change)) ?? unmatched;
    report(`  ${change.status} ${quoted(change.path)} -> ${rule.lane} (${rule.reason})`);
    if (rule.lane === 'full') reasons.push(`${quoted(change.path)}: ${rule.reason}`);
    else if (rule.lane !== 'none') lanes.add(rule.lane);
  }
  if (reasons.length) return { kind: 'full', reasons };
  const evidence = baseEvidence(base);
  if (evidence.kind === 'unvalidated') return { kind: 'full', reasons: [evidence.reason] };
  report(`Base ${base} passed CI: ${evidence.url}`);
  return { kind: 'selective', lanes };
}

const [baseRevision, headRevision, ...extra] = process.argv.slice(2);
assert(baseRevision && headRevision && !extra.length, 'Usage: ci-lanes.mjs <base> <head>');
const head = commit(headRevision);
assert(head, `Head ${headRevision} is not a commit in this checkout`);
const decision = decide(baseRevision, head);
if (decision.kind === 'full') report(['Full pipeline:', ...decision.reasons.map(reason => `  ${reason}`)].join('\n'));
// A full run also runs the workflow example test, inside npm test.
const selection = decision.kind === 'full' ? { full: true, examples: false, extensions: true }
  : { full: false, examples: decision.lanes.has('examples'), extensions: decision.lanes.has('extensions') };
const outputs = Object.entries(selection).map(([name, value]) => `${name}=${value}`);
report(`Selection: ${outputs.join(' ')}`);
process.stdout.write(outputs.join('\n') + '\n');
