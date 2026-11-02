import { appendFileSync } from 'node:fs';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory, type ToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import Type from 'typebox';
import { Compile } from 'typebox/compile';

/*
 * A Pi provider for the RPC test. Each user prompt is a JSON tool call, `{ "tool": ..., "arguments": ... }`, which the
 * model makes; once the call's result arrives, it answers "done". Every request's transcript and last message are
 * appended as one JSON line to the file named by MIPMUX_TEST_PROVIDER_LOG.
 */
// The prompt is parsed JSON, so its arguments are JSON values, as a tool call's arguments must be.
const ScriptedCall = Compile(Type.Object({ tool: Type.String(),
  arguments: Type.Unsafe<ToolCall['arguments']>(Type.Record(Type.String(), Type.Unknown())) }));
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function promptText(content: string | { readonly type: string; readonly text?: string }[]): string {
  return Array.isArray(content) ? content.at(-1)?.text ?? '' : content;
}

export default function scriptedProvider(pi: ExtensionAPI): void {
  const log = process.env.MIPMUX_TEST_PROVIDER_LOG;
  if (log === undefined) throw new Error('MIPMUX_TEST_PROVIDER_LOG names no file');
  const faux = createFauxCore({ api: 'scripted-api', provider: 'scripted', models: [{ id: 'scripted-model' }] });
  // The faux provider answers each request with the next queued step, so each answer queues the next.
  const respond: FauxResponseFactory = context => {
    faux.appendResponses([respond]);
    const last = context.messages.at(-1);
    appendFileSync(log, JSON.stringify({ transcript: context.messages, last }) + '\n');
    if (last?.role !== 'user') return fauxAssistantMessage('done');
    const call: unknown = JSON.parse(promptText(last.content));
    if (!ScriptedCall.Check(call)) throw new Error(`not a scripted call: ${promptText(last.content)}`);
    return fauxAssistantMessage(fauxToolCall(call.tool, call.arguments));
  };
  faux.setResponses([respond]);
  pi.registerProvider('scripted', {
    baseUrl: 'https://scripted.invalid/', apiKey: 'unused', api: 'scripted-api', streamSimple: faux.streamSimple,
    models: [{ id: 'scripted-model', name: 'Scripted', reasoning: false, input: ['text'], cost: zeroCost, contextWindow: 128000, maxTokens: 16000 }],
  });
}
