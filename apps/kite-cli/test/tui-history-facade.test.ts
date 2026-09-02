import { expect, test } from 'bun:test';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import { createTuiHistoryFacade } from '../src/runtime-client/tui-history-facade';

test('formats Runtime History epoch-millisecond timestamps without multiplying them', async () => {
  const updatedAt = Date.UTC(2026, 6, 1, 12, 0, 0);
  let firstRequest: Parameters<RuntimeHistoryClient['listSessions']>[0] | undefined;
  const history: RuntimeHistoryClient = {
    async listSessions(request) {
      firstRequest = request;
      return {
        entries: [
          {
            sessionId: 'history-session',
            displayName: 'History session',
            needsSmartName: false,
            updatedAt,
            lastSequence: 0,
          },
        ],
        hasMore: false,
      };
    },
    async listEvents() {
      throw new Error('not used by this test');
    },
    async loadSession() {
      throw new Error('not used by this test');
    },
  };

  await expect(createTuiHistoryFacade(history).listPersistedSessions()).resolves.toEqual([
    expect.objectContaining({
      threadId: 'history-session',
      updatedAt: expect.stringMatching(/^2026-/u),
    }),
  ]);
  expect(firstRequest).toEqual({ limit: 100 });
  expect(Object.hasOwn(firstRequest!, 'cursor')).toBe(false);
});
