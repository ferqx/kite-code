import { expect, test } from 'bun:test';
import { AgentRuntime } from '../../../src/runtime';
import type { Store } from '../../../src/storage/port';

test('actual Runtime output read preserves cancellation through the final complete semantic hash', async () => {
  const controller = new AbortController();
  const reason = new Error('owned_output_digest_cancel');
  // The actual reader consumes a trusted Store snapshot. No file/Provider work is
  // needed to isolate its final semantic digest after all source-body checks.
  const store: Pick<Store, 'getModelOutputSnapshot'> = {
    async getModelOutputSnapshot() {
      return {
        identity: {
          sessionId: 's',
          executionId: 'model',
          runId: 'run',
          rootSessionId: 's',
          originCommandId: 'command',
          rootWorkCommandId: 'command',
          rootWorkSeq: '1',
          attempt: 1,
          status: 'succeeded',
          modelId: 'fixed',
          confirmation: 'succeeded',
        },
        storeId: 'store',
        originStoreId: 'store',
        subjectId: 'owner',
        snapshotCursor: '1',
        output: null,
        content: 'a'.repeat(16 * 1024 * 1024),
        reasoning: '',
        toolCalls: [],
        complete: true,
      };
    },
  };
  const reader = { options: { store } } as unknown as AgentRuntime;
  const reading = AgentRuntime.prototype.readModelOutput.call(reader, {
    expectedStoreId: 'store',
    sessionId: 's',
    subjectId: 'owner',
    executionId: 'model',
    signal: controller.signal,
  });
  const macro = new Promise<void>((resolve) => {
    setImmediate(() => {
      controller.abort(reason);
      resolve();
    });
  });
  const [error] = await Promise.all([
    reading.then(
      () => undefined,
      (cause: unknown) => cause,
    ),
    macro,
  ]);
  expect(controller.signal.aborted).toBe(true);
  expect(error).toBe(reason);
});
