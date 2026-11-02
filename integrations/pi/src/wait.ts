import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/*
 * Pi delivers a steering message only after the running tool calls return, and a mipmux wait can hold the agent for
 * minutes. `mipmux_wait` makes the same `context_job` wait through Pi's own mipmux connection and cancels it when the
 * user's steering message is accepted; mipmux then ends that wait and leaves the job running. Plain `context_job`
 * waits are blocked so every wait goes through this tool.
 */
export const waitToolName = 'mipmux_wait';
const jobTool = 'mcp__mipmux__context_job';
const maximumWaitMs = 2_147_483_647;
const WaitParameters = Type.Object({
  jobId: Type.String({ description: 'The job ID context_builder returned.' }),
  durationMs: Type.Integer({ minimum: 0, maximum: maximumWaitMs, description: 'How long to wait for the job to settle or ask a question.' }),
});
const blockReason = `Wait with the ${waitToolName} tool instead, called directly with the same jobId and durationMs. It returns the same ` +
  'reply, and it stops waiting when the user sends a steering message, so the message reaches you at once. Use ' +
  `${jobTool} for status, answer, cancel and dispose.`;

// pi-queue-steer keeps an accepted steering message in its own queue until Pi's next delivery boundary, so Pi reports no
// pending message until then; it announces the acceptance with this event, whose payload is its published contract.
const queueSteerAccepted = 'pi-queue-steer:accepted-steer:v1';
const QueueSteerAcceptedSchema = Type.Object({ version: Type.Literal(1), producer: Type.Literal('pi-queue-steer'),
  producerEpochId: Type.String({ minLength: 1 }), sessionId: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 1 }) },
{ additionalProperties: false });
const QueueSteerAccepted = Compile(QueueSteerAcceptedSchema);

/** One wait in progress: its signal aborts when steering is accepted, and `release` ends the tracking. */
interface TrackedWait {
  readonly signal: AbortSignal;
  release(): void;
}

/** The waits in progress, and the steering messages that end them. */
class SteeringWaits {
  readonly #waits = new Set<AbortController>();
  #sessionId: string | null = null;
  #lastAccepted: { readonly epoch: string; readonly sequence: number } | null = null;

  beginSession(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#lastAccepted = null;
  }

  /** A signal that aborts when steering is accepted during the wait; release it when the wait ends. */
  track(): TrackedWait {
    const controller = new AbortController();
    this.#waits.add(controller);
    return { signal: controller.signal, release: () => { this.#waits.delete(controller); } };
  }

  /**
   * A steering message typed or sent over RPC. Pi queues it after the input handlers return, so the check that it was
   * queued, rather than consumed by another extension, runs on the next tick and ends only the waits running now.
   */
  steer(hasPendingMessages: () => boolean): void {
    const waits = [...this.#waits];
    if (!waits.length) return;
    setTimeout(() => { if (hasPendingMessages()) this.#interrupt(waits); }, 0);
  }

  /** pi-queue-steer accepted a steering message; repeated or stale announcements are ignored, as its contract asks. */
  acceptQueued(event: Static<typeof QueueSteerAcceptedSchema>): void {
    if (event.sessionId !== this.#sessionId) return;
    const last = this.#lastAccepted;
    if (last?.epoch === event.producerEpochId && event.sequence <= last.sequence) return;
    this.#lastAccepted = { epoch: event.producerEpochId, sequence: event.sequence };
    this.#interrupt([...this.#waits]);
  }

  #interrupt(waits: readonly AbortController[]): void {
    for (const wait of waits) {
      this.#waits.delete(wait);
      wait.abort('steering');
    }
  }
}

function interrupted(jobId: string) {
  return { content: [{ type: 'text' as const, text: `The wait for mipmux job "${jobId}" ended because the user sent a message; ` +
    `the job is still running. Respond to the message, then call ${waitToolName} with the same jobId to keep waiting.` }],
  details: undefined, isError: true };
}

/** Registers `mipmux_wait`, the steering detection it uses, and the block on plain `context_job` waits. */
export function registerSteerableWait(pi: ExtensionAPI): void {
  const steering = new SteeringWaits();
  // Calls of this tool in progress; their nested context_job waits pass the block.
  const ownCalls = new Set<string>();
  pi.on('session_start', (_event, ctx) => { steering.beginSession(ctx.sessionManager.getSessionId()); });
  pi.on('input', (event, ctx) => {
    if (event.streamingBehavior === 'steer' && event.source !== 'extension') steering.steer(() => ctx.hasPendingMessages());
    return { action: 'continue' };
  });
  pi.events.on(queueSteerAccepted, data => { if (QueueSteerAccepted.Check(data)) steering.acceptQueued(data); });
  pi.on('tool_call', event => {
    const own = event.parentToolCallId !== undefined && ownCalls.has(event.parentToolCallId);
    if (event.toolName !== jobTool || event.input.op !== 'wait' || own) return undefined;
    return { block: true, reason: blockReason };
  });
  pi.registerTool({
    name: waitToolName,
    label: 'mipmux wait',
    description: `Waits for a mipmux context job, as ${jobTool} does with op "wait", and returns mipmux's reply. When the user ` +
      'sends a steering message, the wait ends at once with an error result saying so; the job keeps running, and you wait ' +
      `again with the same jobId after responding. Call it directly, not from a script. Use ${jobTool} for its other operations.`,
    parameters: WaitParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const wait = steering.track();
      ownCalls.add(toolCallId);
      try {
        const outcome = await ctx.executeTool(jobTool, { op: 'wait', jobId: params.jobId, durationMs: params.durationMs },
          { signal: signal === undefined ? wait.signal : AbortSignal.any([signal, wait.signal]) });
        // A wait that settled as steering arrived returns its reply; only a wait the steering cancelled reports the interruption.
        if (outcome.isError && wait.signal.aborted) return interrupted(params.jobId);
        return { content: outcome.result.content, details: outcome.result.details, isError: outcome.isError };
      } finally {
        ownCalls.delete(toolCallId);
        wait.release();
      }
    },
  });
}
