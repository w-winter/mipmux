import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { createMockModel } from '@oh-my-pi/pi-ai/providers/mock';
import Type from '#typebox';
import { Compile } from 'typebox/compile';

/*
 * An omp provider for the RPC test. Each user prompt is a JSON tool call, `{ "tool": ..., "arguments": ... }`, which the
 * model makes; once the call's result arrives, it answers "done". Every request's prompt blocks and last message are
 * appended as one JSON line to the file named by MIPMUX_TEST_PROVIDER_LOG.
 */
const ScriptedCall = Compile(Type.Object({ tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }));
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The prompt as sent; omp puts its own reminder blocks before it. */
function promptText(content: string | { readonly type: string; readonly text?: string }[]): string {
  return Array.isArray(content) ? content.at(-1)?.text ?? '' : content;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  const log = process.env.MIPMUX_TEST_PROVIDER_LOG;
  if (log === undefined) throw new Error('MIPMUX_TEST_PROVIDER_LOG names no file');
  const model = createMockModel({
    handler: context => {
      const last = context.messages.at(-1);
      appendFileSync(log, JSON.stringify({ systemPrompt: context.systemPrompt ?? [], last }) + '\n');
      if (last?.role !== 'user') return { content: ['done'] };
      const call: unknown = JSON.parse(promptText(last.content));
      if (!ScriptedCall.Check(call)) throw new Error(`not a scripted call: ${promptText(last.content)}`);
      return { content: [{ type: 'toolCall', name: call.tool, arguments: call.arguments }] };
    },
  });
  pi.registerProvider('scripted', {
    baseUrl: 'https://scripted.invalid/', apiKey: 'unused', api: 'scripted-api',
    streamSimple: (_model, context, options) => model.stream(model, context, options),
    models: [{ id: 'scripted-model', name: 'Scripted', reasoning: false, input: ['text'], cost: zeroCost, contextWindow: 128000, maxTokens: 16000 }],
  });
}
