import { expect, test } from 'bun:test';
import { imageWindowRecovery } from '../../../src/execution/image-window-recovery';
import type { ExecutionRecord, Json } from '../../../src/storage/types';

const source = (kind: string): Record<string, Json> => ({
  imageWindow: { version: 1, kind, route: 'r', members: [] },
});
const execution = (status: string, result: Json | null = null) =>
  ({ status, result }) as ExecutionRecord;
test('confirmed observer rebuilds business, never completes it', () => {
  expect(
    imageWindowRecovery(
      execution('succeeded', { finishReason: 'stop', toolCalls: [], observation: { note: 'n' } }),
      source('observation'),
    ).rebuild,
  ).toBe(true);
  expect(() =>
    imageWindowRecovery(
      execution('succeeded', { finishReason: 'tool_calls', toolCalls: [] }),
      source('observation'),
    ),
  ).toThrow();
  expect(imageWindowRecovery(execution('succeeded'), source('business')).rebuild).toBe(false);
});
for (const kind of ['business', 'observation'])
  test(
    kind + ' unknown is not replayable, explicit rejection and non-dispatch remain distinct',
    () => {
      for (const status of ['running', 'dispatching', 'outcome_unknown', 'cancelled', 'failed'])
        expect(() => imageWindowRecovery(execution(status), source(kind))).toThrow(
          'image_window_outcome_unknown',
        );
      expect(imageWindowRecovery(execution('planned'), source(kind)).rebuild).toBe(false);
      expect(
        imageWindowRecovery(
          execution('failed', { code: 'model_request_body_too_large' }),
          source(kind),
        ).rejected,
      ).toBe(true);
      expect(
        imageWindowRecovery(execution('cancelled', { dispatchCommitted: false }), source(kind))
          .rebuild,
      ).toBe(true);
    },
  );
