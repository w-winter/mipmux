import assert from 'node:assert/strict';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

const example = Compile(Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }));
const exampleOutputBytes = 12000;
const toolList = '`manage_selection`, `prompt`, `workspace_context`, `get_file_tree`, `get_code_structure`, `file_search`, `read_file`, `git`';

export function bindReferenceDiscoveryPolicy(source, input) {
  const handoff = input.enhancementMode !== 'preserve';
  const restrictedReview = input.responseType === 'review' && input.restrictsReviewGitToExplicitReadOnly;
  const baseExamples = handoff ? 10 : 9;
  let reviewExamples = input.responseType === 'review' ? 1 : 0;
  if (restrictedReview) reviewExamples = input.reviewRootNames.length ? 2 : 0;
  const examples = /\{"tool":"[^\n]+"args":\{[^\n]*\}\}/g;
  for (const [pattern, count] of [
    [toolList, 2],
    ["This prompt comes directly from RepoPrompt. The MCP server's workspace state already matches what you see here—codemaps for selected files, the selected-mode file tree, and the `<current_prompt_content>` (user's prompt) are embedded.", 1],
    ['RepoPrompt MCP tools', 2],
    ["These tools provide complete access to the user's project—attempting to use any other approach will fail.", 1],
    ['any non-MCP tools', 1], ['prefix all paths correctly', 1],
    ['`repo_root` (or `repo_key`)', restrictedReview ? 1 : 0],
    ['`repo_root`/`repo_key`', restrictedReview ? 1 : 0],
    ['`repo_root`', restrictedReview ? 3 : 0], ['`<discovery_agent-guidelines>`', 1],
    ['architectural clarity, symbol relationships, and taskname metadata', input.enhancementMode === 'fullRewrite' ? 1 : 0],
    ['workspace_context', 9],
  ]) assert.equal(source.split(pattern).length - 1, count, 'Unexpected pinned policy shape for ' + pattern);
  for (const [pattern, count] of [
    [/^\*\*Task Naming:\*\*[^\n]*\n/gm, 1],
    [/^\s*Begin with (?:a standalone )?`<taskname=[^\n]*\n/gm, handoff ? 1 : 0],
    [/^\s*<taskname="Short summary"\/>\n/gm, input.enhancementMode === 'augment' ? 1 : 0],
    [/^.*- 🚫 Omitting the <taskname=[^\n]*\n/gm, handoff ? 1 : 0],
    [examples, baseExamples + reviewExamples + Number(input.allowClarifyingQuestions)],
  ]) assert.equal([...source.matchAll(pattern)].length, count, 'Unexpected pinned policy shape for ' + String(pattern));

  return source
    .replaceAll(toolList, '`manage_selection`, `prompt`, `draft_inspect`, `get_file_tree`, `get_code_structure`, `file_search`, `read_file`, `git`, `draft_update`, `draft_validate`')
    .replace("This prompt comes directly from RepoPrompt. The MCP server's workspace state already matches what you see here—codemaps for selected files, the selected-mode file tree, and the `<current_prompt_content>` (user's prompt) are embedded.",
      "This prompt uses RepoPrompt CE's discovery policy. The captured mipmux observation identifies the admitted roots, selection, costs and evidence; the file tree and `<current_prompt_content>` are embedded. Use the context tools for complete material bodies.")
    .replaceAll('RepoPrompt MCP tools', 'mipmux context tools and configured HTTP MCP tools')
    .replace("These tools provide complete access to the user's project—attempting to use any other approach will fail.",
      'Context tools enforce declared roots and protected-path policy. Configured HTTP MCP tools have their separately authorized capabilities.')
    .replaceAll('any non-MCP tools', 'any unexposed tools')
    .replaceAll('prefix all paths correctly', 'use root-qualified selection paths and separate root/path fields where required')
    .replaceAll('`repo_root` (or `repo_key`)', '`root` (or `worktree`)')
    .replaceAll('`repo_root`/`repo_key`', '`root`/`worktree`')
    .replaceAll('`repo_root`', '`root`')
    .replaceAll('`<discovery_agent-guidelines>`', '`<discover_instructions>`')
    .replace(/^\*\*Task Naming:\*\*[^\n]*\n/gm, '')
    .replace(/^\s*Begin with (?:a standalone )?`<taskname=[^\n]*\n/gm, '\n')
    .replace(/^\s*<taskname="Short summary"\/>\n/gm, '')
    .replace(/^.*- 🚫 Omitting the <taskname=[^\n]*\n/gm, '')
    .replace('architectural clarity, symbol relationships, and taskname metadata', 'architectural clarity and symbol relationships')
    .replace(examples, text => {
      const call = example.Parse(JSON.parse(text));
      if (call.tool === 'ask_user') return JSON.stringify({ tool: call.tool, args: {
        questions: [{ id: 'response', question: call.args.question, options: call.args.options }], context: call.args.context,
      } });
      if (call.tool === 'workspace_context') return JSON.stringify({ tool: 'draft_inspect', args: {
        view: 'include' in call.args ? 'costs' : 'metadata', maxOutputBytes: exampleOutputBytes, continuation: null,
      } });
      if (call.tool === 'git' && 'repo_root' in call.args) {
        if (call.args.op === 'diff') call.args.root = call.args.repo_root;
        else call.args.repositories = [{ root: call.args.repo_root }];
        delete call.args.repo_root;
      }
      if (call.tool === 'prompt' && call.args.op !== 'get') call.args.expectedRevision = 0;
      call.args.maxOutputBytes = exampleOutputBytes;
      return JSON.stringify(call);
    })
    .replaceAll('workspace_context', 'draft_inspect') + '\n\n## mipmux runtime bindings\n\n' +
    'The user message contains the source startup sections followed by a captured runtime observation. Its constraints are fixed caller requirements. ' +
    'Use draft_inspect with view "costs" for complete-packet accounting and view "metadata" for committed state. ' +
    'Supply maxOutputBytes for tool replies. Prompt mutations also require the latest expectedRevision from the observation or a mutation reply; 0 in examples is a placeholder. ' +
    'For Git status/log/show/blame, use repositories:[{root,path?,worktree?}] for explicit targets; diff uses root and worktree directly. ' +
    'Omitting repositories uses the frozen selected checkouts; multi-repository log/show/blame require an explicit target. ' +
    'Use draft_validate for the final publication check, then acknowledge completion. The parent verifies and publishes the packet; the final assistant text is not the packet. ' +
    'Required caller evidence cannot be removed to force the budget. If it cannot fit, retain it and report the blocking diagnostic.\n';
}
