import Type, { type Static } from 'typebox';
import { Base64 } from './artifact.js';
import { GitDiff } from './git.js';
import { RelativePath } from './workspace.js';

const closed = { additionalProperties: false };
const counts = Type.Object({ files: Type.Integer(), insertions: Type.Integer(), deletions: Type.Integer() }, closed);
const byStatus = Type.Record(Type.String(), Type.Integer());
const text = Type.Optional(Type.String());
export const GitArtifactWorktree = Type.Object({ is_worktree: Type.Boolean(), worktree_root: Type.String(),
  worktree_name: text, common_git_dir: text, main_worktree_root: text, worktree_branch: text,
  main_branch: text, worktree_head: text, main_head: text }, closed);
const artifacts = Type.Object({ manifest: Type.String(), map: Type.String(), files_tsv: Type.String(), tree: Type.String(),
  changed_lines: text, selection_paths: text, all_patch: text, deep_hunks: text, deep_changed_lines: text }, closed);
const primary = Type.Object({ map: Type.String(), all_patch: text, auto_selected: Type.Optional(Type.Array(Type.String())),
  per_file_patches: Type.Optional(Type.Array(Type.Object({ jump_index: Type.Integer(), git_path: Type.String(),
    selection_path: Type.String(), status: text, additions: Type.Optional(Type.Integer()), deletions: Type.Optional(Type.Integer()) }, closed))) }, closed);
const summary = Type.Object({ ...counts.properties, by_status: Type.Optional(byStatus) }, closed);
const inline = Type.Object({ map_excerpt: Type.String(), truncated: Type.Boolean(), total_lines: Type.Integer(),
  returned_lines: Type.Integer() }, closed);
const inputs = Type.Object({ compare: Type.String(), compare_input: text, scope: Type.Enum(['all', 'selected']),
  requested_paths_count: Type.Optional(Type.Integer()), context_lines: Type.Integer(), detect_renames: Type.Boolean() }, closed);
const projected = { diff: GitDiff, snapshot_id: Type.String(), snapshot_dir: Type.String(), artifacts,
  primary_artifacts: Type.Optional(primary), summary, oneliner: Type.String(), inputs, mode_details: Type.String(),
  inline: Type.Optional(inline), worktree: Type.Optional(GitArtifactWorktree), warning: text, empty_reason: text };
const repository = { repo_root: Type.String(), repo_key: Type.String(), repo_name: text };
export const GitArtifactRepoReply = Type.Union([
  Type.Object({ ...repository, ...projected }, closed),
  Type.Object({ ...repository, error: Type.String(), warning: text }, closed),
]);
export const GitArtifactReply = Type.Object({ op: Type.Literal('diff'), ...projected, primary_artifacts: primary }, closed);
export const GitArtifactReposReply = Type.Object({ op: Type.Literal('diff'), repos: Type.Array(GitArtifactRepoReply),
  aggregate: Type.Object({ totals: counts, by_status: Type.Optional(byStatus), oneliner: Type.String(), repo_count: Type.Integer() }, closed) }, closed);
export const NativeGitArtifactInput = Type.Union([
  Type.Object({ kind: Type.Literal('projectGitArtifacts'), snapshotDir: Type.String(), snapshotDirectoryPath: Type.String({ pattern: '^/[^\u0000]*$' }),
    manifest: Base64, availablePaths: Type.Array(RelativePath), mapBytes: Type.Union([Base64, Type.Null()]),
    compareDisplay: Type.String(), mode: Type.Enum(['quick', 'standard', 'deep']), inlineMap: Type.Boolean(),
    inlineMode: Type.String(), inlineMaxLines: Type.Integer(), autoSelectedPaths: Type.Array(Type.String()),
    worktree: Type.Union([GitArtifactWorktree, Type.Null()]), warning: Type.Union([Type.String(), Type.Null()]) }, closed),
  Type.Object({ kind: Type.Literal('decorateGitArtifacts'), repos: Type.Array(GitArtifactRepoReply),
    manifests: Type.Record(Type.String(), Base64), autoSelectedPaths: Type.Array(Type.String()),
    readinessWarnings: Type.Record(Type.String(), Type.String()) }, closed),
]);
export type NativeGitArtifactInput = Static<typeof NativeGitArtifactInput>;
export const NativeGitArtifactResult = Type.Union([
  Type.Object({ kind: Type.Literal('gitArtifacts'), reply: GitArtifactReply,
    publishedArtifacts: Type.Array(Type.Object({ kind: Type.Enum(['manifest', 'map', 'allPatch', 'perFilePatch']),
      absolutePath: Type.String(), gitDataRelativePath: Type.String(), clientAlias: Type.Union([Type.String(), Type.Null()]),
      selectionDisposition: Type.Enum(['authorizationDependency', 'primaryAutoSelect', 'advertisedSelectable']) }, closed)),
    primarySelectionAliases: Type.Array(Type.String()), advertisedSelectionAliases: Type.Array(Type.String()) }, closed),
  Type.Object({ kind: Type.Literal('gitArtifactProjectionError'), message: Type.String() }, closed),
  Type.Object({ kind: Type.Literal('gitArtifactRepos'), reply: GitArtifactReposReply }, closed),
]);
export type GitArtifactReply = Static<typeof GitArtifactReply>;
