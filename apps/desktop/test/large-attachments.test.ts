import { expect, test } from 'bun:test';
import { interactionAttachment } from '@kite-ai/client';
import { createDesktopController } from '../src/controller';
import { largeInteractionFixture } from './fixtures/large-interaction';

async function failure(read: () => Promise<unknown>) {
  try {
    await read();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('actual Desktop exact attachment proof cannot cross a view switch or late response; verified original answer dispatches once', async () => {
  const f = await largeInteractionFixture();
  const controller = createDesktopController({ admittedClient: f.client, onSnapshot() {} });
  try {
    const card = await f.start();
    await controller.selectSession('s');
    expect(
      await failure(() =>
        controller.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
      ),
    ).toMatchObject({ code: 'attachment_not_loaded' });
    const attachment = interactionAttachment(card)!;
    const original = f.client.readInteractionAttachment.bind(f.client);
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.client.readInteractionAttachment = async (...input) => {
      const body = await original(...input);
      entered();
      await gate;
      return body;
    };
    const loading = controller.readInteractionAttachment(attachment, {
      signal: new AbortController().signal,
    });
    const rejected = loading.catch((error) => error);
    await entry;
    await controller.selectSession('other');
    await controller.selectSession('s');
    release();
    expect(await rejected).toBeDefined();
    expect(
      await failure(() =>
        controller.answerInteraction(card, { kind: 'approval', decision: 'approve' }),
      ),
    ).toMatchObject({ code: 'attachment_not_loaded' });
    expect(f.effects()).toBe(0);
    f.client.readInteractionAttachment = original;
    const body = await controller.readInteractionAttachment(attachment, {
      signal: new AbortController().signal,
    });
    expect(body.content.byteLength).toBe(Number(attachment.reference.size));
    const first = controller.answerInteraction(card, { kind: 'approval', decision: 'approve' });
    expect(controller.answerInteraction(card, { kind: 'approval', decision: 'approve' })).toBe(
      first,
    );
    await first;
    await f.runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(f.effects()).toBe(1);
    expect(controller.interactionSubmissions).toHaveLength(1);
    expect(controller.interactionSubmissions[0]!.intent.expectedStoreId).toBe(card.originStoreId);
  } finally {
    controller.disposeNetwork();
    await f.close();
  }
}, 30000);
