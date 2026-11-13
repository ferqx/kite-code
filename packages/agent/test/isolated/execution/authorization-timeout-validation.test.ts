import { rmSync } from 'node:fs';
import { createFixedModel } from '@kite-ai/ai';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { maximumAuthorizationCheckTimeoutMs } from '../../../src/execution/authorization-timing';
import { openSqliteStore } from '../../../src/sqlite';

test('host checker binding rejects overflowing timer delays before any model or execution can start', async () => {
  const root = temporaryDirectory('kite-check-timeout-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const model = createFixedModel([]);
  const permissions = {
    async authorize(): Promise<never> {
      throw new Error('No execution was requested');
    },
  };
  try {
    const before = await store.getMetadata();
    for (const timeoutMs of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      maximumAuthorizationCheckTimeoutMs + 1,
      Number.MAX_SAFE_INTEGER,
    ])
      expect(() =>
        createRuntime({
          store,
          model,
          modelId: 'fixture',
          permissions,
          authorizationCheck: { id: 'checker', version: '1', modelId: 'checker', model, timeoutMs },
        }),
      ).toThrow('invalid_authorization_check_timeout');
    for (const timeoutMs of [undefined, 1, maximumAuthorizationCheckTimeoutMs]) {
      const acceptedStore = await openSqliteStore({
        dataRoot: root,
        profile: `valid-${timeoutMs ?? 'default'}`,
      });
      const acceptedBefore = await acceptedStore.getMetadata();
      const runtime = createRuntime({
        store: acceptedStore,
        model,
        modelId: 'fixture',
        permissions,
        authorizationCheck: { id: 'checker', version: '1', modelId: 'checker', model, timeoutMs },
      });
      try {
        expect((await acceptedStore.getMetadata()).lastChangeCursor).toBe(
          acceptedBefore.lastChangeCursor,
        );
      } finally {
        await runtime.close();
      }
    }
    expect(model.requests).toEqual([]);
    expect((await store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
