import { expect, test } from 'bun:test';
import type { RuntimeAccess, RuntimeCommand, RuntimeQueryResult } from '@kite-ai/runtime-contract';
import { recoverSessionIfSafe } from '../src/recovery';

test('recovery helper does not mutate an unconfirmed or unknown execution', async () => {
  const calls: RuntimeCommand[] = [];
  const runtime: Pick<RuntimeAccess, 'query' | 'command'> = {
    query: async () => ({
      status: 'ok',
      queryType: 'get_session_recovery',
      recovery: {
        authorityRevision: 5,
        status: 'recovery_required',
        cleanupConfirmed: false,
        pendingEffectCount: 1,
        unknownEffectCount: 0,
        action: 'inspect',
      },
    }),
    command: async (command) => {
      calls.push(command);
      throw new Error('Must not mutate');
    },
  };
  expect(await recoverSessionIfSafe(runtime, 's', 'r')).toBeUndefined();
  expect(calls).toHaveLength(0);
});

test('recovery helper binds both revisions and never submits a task or retries unknown results', async () => {
  const calls: RuntimeCommand[] = [];
  const runtime: Pick<RuntimeAccess, 'query' | 'command'> = {
    query: async (query) =>
      (query.type === 'get_session_recovery'
        ? {
            status: 'ok',
            queryType: query.type,
            recovery: {
              authorityRevision: 5,
              status: 'recovery_required',
              cleanupConfirmed: true,
              pendingEffectCount: 0,
              unknownEffectCount: 0,
              action: 'recover',
            },
          }
        : {
            status: 'ok',
            queryType: query.type,
            session: { sessionId: 's', revision: 10 },
          }) as RuntimeQueryResult,
    command: async (command) => {
      calls.push(command);
      throw new Error('receipt lost');
    },
  };
  await expect(recoverSessionIfSafe(runtime, 's', 'recovery-id')).rejects.toThrow('receipt lost');
  expect(calls).toEqual([
    {
      schema: 'kite.runtime-command.v1',
      type: 'recover_session',
      commandId: 'recovery-id',
      sessionId: 's',
      expectedRevision: 10,
      expectedAuthorityRevision: 5,
    },
  ]);
});

test('a lost recovery reply is resolved by a read of the original command identity', async () => {
  let writes = 0;
  const queries: string[] = [];
  const runtime: Pick<RuntimeAccess, 'query' | 'command'> = {
    command: async () => {
      writes++;
      throw new Error('reply lost');
    },
    query: async (query) => {
      queries.push(query.type);
      if (query.type === 'get_command_receipt') {
        expect(query.command.commandId).toBe('same-recovery');
        return {
          status: 'ok',
          queryType: query.type,
          receipt: {
            status: 'idempotent_replay',
            commandId: 'same-recovery',
            sessionId: 's',
            originalRevision: 3,
          },
        };
      }
      return (
        query.type === 'get_session_recovery'
          ? {
              status: 'ok',
              queryType: query.type,
              recovery: {
                authorityRevision: 8,
                status: 'recovery_required',
                cleanupConfirmed: true,
                pendingEffectCount: 0,
                unknownEffectCount: 0,
                action: 'recover',
              },
            }
          : { status: 'ok', queryType: query.type, session: { sessionId: 's', revision: 3 } }
      ) as RuntimeQueryResult;
    },
  };
  expect(await recoverSessionIfSafe(runtime, 's', 'same-recovery')).toMatchObject({
    status: 'idempotent_replay',
  });
  expect(writes).toBe(1);
  expect(queries).toEqual([
    'get_session_recovery',
    'get_session_projection',
    'get_command_receipt',
  ]);
});
