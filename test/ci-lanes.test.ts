import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const script = resolve('scripts/ci-lanes.mjs');
const gitExecutable = process.env.MIPMUX_TEST_GIT ?? (process.platform === 'darwin' ? '/opt/homebrew/bin/git' : '/usr/bin/git');
const baseFiles = ['CHANGELOG.md', 'README.md', 'SECURITY.md', 'LICENSE', 'docs/guide.md', 'docs/vendor-provenance.json', 'src/index.ts',
  'src/notes.md', 'workflow-examples/pi/SKILL.md', 'integrations/pi/src/state.ts', 'integrations/pi/README.md',
  'integrations/omp/README.md', 'integrations/omp/package-lock.json'];

interface Selection { readonly full: boolean; readonly examples: boolean; readonly extensions: boolean }
const fullPipeline: Selection = { full: true, examples: false, extensions: true };
const nothing: Selection = { full: false, examples: false, extensions: false };

type Edit =
  | { readonly kind: 'write'; readonly path: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string };

interface WorkflowRun {
  readonly head_sha: string; readonly status: string; readonly conclusion: string | null;
  readonly event?: string; readonly head_branch?: string;
}
/** What the stand-in `gh` does: print a response body, or fail with a message on stderr. */
type GhReply = { readonly kind: 'body'; readonly text: string } | { readonly kind: 'fail'; readonly stderr: string };

/** A Git repository holding `baseFiles` at its base commit, and a stand-in `gh` that logs its arguments. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mipmux-ci-lanes-'));
  const repository = join(directory, 'repository'), bin = join(directory, 'bin'), log = join(directory, 'gh.log');
  const reply = join(directory, 'gh-reply'), failure = join(directory, 'gh-failure');
  mkdirSync(repository); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ -f '${failure}' ]; then cat '${failure}' >&2; exit 1; fi\ncat '${reply}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  // User and system Git settings, such as diff.renames, must not change what the script sees.
  const env = { PATH: `${bin}:${dirname(gitExecutable)}:/usr/bin:/bin`, HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args: readonly string[]) => execFileSync(gitExecutable, args, { cwd: repository, env, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  for (const path of baseFiles) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), `${path}\n`);
  }
  git(['add', '--all']); git(['commit', '-q', '-m', 'base']);
  const base = git(['rev-parse', 'HEAD']);
  return {
    base,
    /** Commits `edits` applied to the base and returns the new commit. */
    head(edits: readonly Edit[]): string {
      git(['checkout', '-q', '--detach', base]);
      for (const edit of edits) {
        if (edit.kind === 'write') {
          mkdirSync(dirname(join(repository, edit.path)), { recursive: true });
          writeFileSync(join(repository, edit.path), `changed ${edit.path}\n`);
        } else if (edit.kind === 'delete') unlinkSync(join(repository, edit.path));
        else if (edit.kind === 'rename') {
          mkdirSync(dirname(join(repository, edit.to)), { recursive: true });
          renameSync(join(repository, edit.from), join(repository, edit.to));
        } else {
          unlinkSync(join(repository, edit.path));
          symlinkSync(edit.target, join(repository, edit.path));
        }
      }
      git(['add', '--all']); git(['commit', '-q', '-m', 'head']);
      return git(['rev-parse', 'HEAD']);
    },
    /** Runs the script with `gh` giving `ghReply`, and returns the jobs it selected. */
    select(baseRevision: string, head: string, ghReply: GhReply): Selection {
      writeFileSync(reply, ghReply.kind === 'body' ? ghReply.text : '');
      if (ghReply.kind === 'fail') writeFileSync(failure, ghReply.stderr);
      else if (existsSync(failure)) unlinkSync(failure);
      const result = spawnSync(process.execPath, [script, baseRevision, head], { cwd: repository, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const lines = result.stdout.split('\n');
      assert.equal(lines.pop(), '', result.stdout);
      assert.deepEqual(lines.map(line => line.replace(/=(?:true|false)$/u, '')), ['full', 'examples', 'extensions'], result.stdout);
      const [full, examples, extensions] = lines.map(line => line.endsWith('=true'));
      return { full: full === true, examples: examples === true, extensions: extensions === true };
    },
    ghCalls: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

const runs = (list: readonly WorkflowRun[]): GhReply => ({ kind: 'body', text: JSON.stringify({ total_count: list.length,
  workflow_runs: list.map((run, index) => ({ id: index + 1, event: 'push', head_branch: 'main', html_url: `https://example.invalid/${index + 1}`, ...run })) }) });
const succeeded = (sha: string): WorkflowRun => ({ head_sha: sha, status: 'completed', conclusion: 'success' });
const failed = (sha: string): WorkflowRun => ({ head_sha: sha, status: 'completed', conclusion: 'failure' });

test('routes each changed path to the jobs its rules require', () => {
  const repository = fixture();
  const evidence = runs([failed(repository.base), succeeded(repository.base)]);
  const cases: readonly { readonly edits: readonly Edit[]; readonly expected: Selection }[] = [
    { edits: [{ kind: 'write', path: 'CHANGELOG.md' }, { kind: 'write', path: 'docs/guide.md' }, { kind: 'write', path: 'integrations/pi/README.md' },
      { kind: 'delete', path: 'SECURITY.md' }, { kind: 'write', path: 'docs/new.md' }],
    expected: nothing },
    { edits: [{ kind: 'write', path: 'docs/vendor-provenance.json' }], expected: nothing },
    { edits: [{ kind: 'write', path: 'workflow-examples/pi/SKILL.md' }], expected: { ...nothing, examples: true } },
    { edits: [{ kind: 'write', path: 'integrations/pi/src/state.ts' }], expected: { ...nothing, extensions: true } },
    { edits: [{ kind: 'delete', path: 'integrations/omp/README.md' }], expected: { ...nothing, extensions: true } },
    // Package staging rejects a README.md that contains the checkout path.
    { edits: [{ kind: 'write', path: 'README.md' }], expected: fullPipeline },
    { edits: [{ kind: 'delete', path: 'README.md' }], expected: fullPipeline },
    { edits: [{ kind: 'symlink', path: 'README.md', target: 'LICENSE' }], expected: fullPipeline },
    { edits: [{ kind: 'rename', from: 'src/notes.md', to: 'docs/notes.md' }], expected: fullPipeline },
    { edits: [{ kind: 'write', path: 'LICENSE' }], expected: fullPipeline },
    { edits: [{ kind: 'write', path: 'CONTRIBUTING.md' }], expected: fullPipeline },
    { edits: [{ kind: 'write', path: 'src/index.ts' }, { kind: 'write', path: 'workflow-examples/pi/SKILL.md' },
      { kind: 'write', path: 'docs/guide.md' }], expected: fullPipeline },
    { edits: [{ kind: 'write', path: 'workflow-examples/pi/SKILL.md' }, { kind: 'write', path: 'integrations/omp/package-lock.json' }],
    expected: { ...nothing, examples: true, extensions: true } },
  ];
  for (const { edits, expected } of cases) {
    assert.deepEqual(repository.select(repository.base, repository.head(edits), evidence), expected, JSON.stringify(edits));
  }
  // Pull-request runs test a merge tree rather than their head commit, so only push runs on main count as evidence.
  const query = repository.ghCalls().split('\n')[0] ?? '';
  for (const part of ['actions/workflows/ci.yml/runs', `head_sha=${repository.base}`, 'event=push', 'branch=main']) {
    assert(query.includes(part), query);
  }
});

test('requires the full pipeline unless the base has a successful CI push run on main', () => {
  const repository = fixture();
  const head = repository.head([{ kind: 'write', path: 'CHANGELOG.md' }]);
  const replies: readonly GhReply[] = [
    runs([failed(repository.base)]),
    runs([{ head_sha: repository.base, status: 'in_progress', conclusion: null }]),
    runs([]),
    runs([succeeded('f'.repeat(40))]),
    runs([{ ...succeeded(repository.base), event: 'pull_request' }]),
    runs([{ ...succeeded(repository.base), head_branch: 'feature' }]),
    { kind: 'fail', stderr: 'HTTP 502: Bad Gateway\n' },
    { kind: 'body', text: 'not json' },
  ];
  for (const reply of replies) assert.deepEqual(repository.select(repository.base, head, reply), fullPipeline, JSON.stringify(reply));
});

test('requires the full pipeline when the base commit is unavailable', () => {
  const repository = fixture();
  const head = repository.head([{ kind: 'write', path: 'CHANGELOG.md' }]);
  for (const base of ['0'.repeat(40), 'e'.repeat(40)]) {
    assert.deepEqual(repository.select(base, head, runs([succeeded(base)])), fullPipeline, base);
  }
  assert.equal(repository.ghCalls(), '');
});
