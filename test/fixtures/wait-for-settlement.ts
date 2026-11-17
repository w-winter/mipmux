import type { Client } from '@modelcontextprotocol/client';
import Type from 'typebox';
import { Compile } from 'typebox/compile';
import { toolJSON, type JsonValue } from './tool-json.js';

export const packageOperationTimeoutMs = 2 * 60 * 1000;

export async function waitForSettlement(client: Client, jobId: string,
  signal: AbortSignal = AbortSignal.timeout(packageOperationTimeoutMs)) {
  const observation = Compile(Type.Object({ localSettled: Type.Boolean() }));
  let lastReply: JsonValue = null;
  try {
    for (;;) {
      signal.throwIfAborted();
      const reply = await client.callTool({ name: 'context_job', arguments: { op: 'wait', jobId, durationMs: 10000 } }, { signal });
      lastReply = toolJSON(reply);
      if (reply.isError) throw new Error('context_job returned an error');
      if (observation.Parse(lastReply).localSettled) return reply;
    }
  } catch (cause) {
    const failure = new Error(`Job ${jobId} did not settle. Last reply: ${JSON.stringify(lastReply)}`, { cause });
    throw failure;
  }
}
