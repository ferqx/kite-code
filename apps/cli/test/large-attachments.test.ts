import { expect, test } from 'bun:test';
import { run } from '../src';
import { largeInteractionFixture } from './fixtures/large-interaction';

test('actual CLI handler receives complete verified attachment before an exact answer; failed reader returns known waiting without effects', async () => {
  const f = await largeInteractionFixture();
  try {
    await f.start();
    f.setCorrupt(true);
    let handlers = 0;
    const intent = {
      expectedStoreId: f.storeId,
      commandId: 'work',
      kind: 'run.start' as const,
      content: 'actual harmless request',
    };
    const waiting = await run('s', intent, {
      client: f.client,
      write() {},
      pollIntervalMs: 1,
      timeoutMs: 15000,
      async answerInteraction() {
        handlers++;
        return { kind: 'approval', decision: 'approve' };
      },
    });
    expect(waiting.status).toBe('waiting_interaction');
    expect(handlers).toBe(0);
    expect(f.effects()).toBe(0);
    f.setCorrupt(false);
    const result = await run('s', intent, {
      client: f.client,
      write() {},
      pollIntervalMs: 1,
      timeoutMs: 15000,
      async answerInteraction(interaction, context) {
        handlers++;
        expect(context.completeAttachment).toBeDefined();
        expect(JSON.parse(context.completeAttachment!.text).task).toBe(f.body);
        expect(context.completeAttachment!.reference.scope).toEqual(
          (
            interaction.request as {
              policy: {
                review: {
                  reference: { scope: { kind: 'session' | 'execution' | 'message'; id: string } };
                };
              };
            }
          ).policy.review.reference.scope,
        );
        return { kind: 'approval', decision: 'approve' };
      },
    });
    expect(result.status).toBe('succeeded');
    expect(handlers).toBe(1);
    expect(f.effects()).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);
