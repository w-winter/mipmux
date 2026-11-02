import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/*
 * Stands in for the pi-queue-steer extension in the RPC test. That extension keeps an accepted steering message in its
 * own queue until Pi's next delivery boundary and announces the acceptance on Pi's event bus; `/accept-steer` emits
 * the same announcement, with a new sequence number each time.
 */
export default function queueSteer(pi: ExtensionAPI): void {
  let sequence = 0;
  pi.registerCommand('accept-steer', { description: 'Announce an accepted steering message as pi-queue-steer does',
    handler: async (_args, ctx) => {
      sequence += 1;
      pi.events.emit('pi-queue-steer:accepted-steer:v1', { version: 1, producer: 'pi-queue-steer', producerEpochId: 'test-epoch',
        sessionId: ctx.sessionManager.getSessionId(), sequence });
    } });
}
