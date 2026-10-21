import { expect, test } from 'bun:test';
import {
  type AgentClient,
  type Command,
  type Json,
  type Run,
  readOrdinaryCommandApplication,
} from '../src';

const command = {
  id: 'public',
  kind: 'run.start',
  sessionId: 's',
  originStoreId: 'store',
  subjectId: 'user',
  status: 'applied',
  cancelRequestedAt: null,
  receipt: {
    outcome: 'human_input_applied',
    businessCommandId: 'business',
    sourceCommandId: 'business',
    runId: 'run',
  },
} as Command;
const run = {
  id: 'run',
  sessionId: 's',
  originStoreId: 'store',
  originCommandId: 'business',
  status: 'completed',
  isActive: false,
} as Run;
function client(patch: Record<string, unknown> = {}) {
  return {
    getRun: async () => run,
    getCommand: async () => ({ ...command, id: 'business', receipt: { runId: 'run' } }),
    getExecution: async () => ({
      id: 'model',
      kind: 'model',
      status: 'succeeded',
      runId: 'run',
      sessionId: 's',
      originStoreId: 'store',
    }),
    ...patch,
  } as unknown as AgentClient;
}
test('public ordinary ID resolves exact saved business Run without a mutation', async () => {
  const actual = await readOrdinaryCommandApplication(client(), command);
  expect(actual?.run).toEqual(run);
  expect(actual?.sourceCommandId).toBe('business');
});
test('active supplement retains original Run origin and exact business application', async () => {
  const actual = await readOrdinaryCommandApplication(
    client({
      getCommand: async () => ({
        ...command,
        id: 'business',
        kind: 'input.steer',
        receipt: { runId: 'run' },
      }),
      getRun: async () => ({ ...run, originCommandId: 'original' }),
    }),
    command,
  );
  expect(actual?.run?.originCommandId).toBe('original');
});
test('independent human work submitted as a technical steer resolves its business Run beyond the original observed Run', async () => {
  const input = { ...command, kind: 'input.steer' as const };
  const actual = await readOrdinaryCommandApplication(
    client({
      getCommand: async () => ({
        ...command,
        id: 'business',
        kind: 'input.follow_up',
        receipt: { runId: 'run' },
      }),
    }),
    input,
    { targetRunId: 'original-observed-run' },
  );
  expect(actual?.run).toEqual(run);
  expect(actual?.sourceCommandId).toBe('business');
  expect(input).toMatchObject({ id: 'public', kind: 'input.steer' });
});
test('foreign or forged business facts cannot bind a public input', async () => {
  for (const patch of [
    { getRun: async () => ({ ...run, sessionId: 'other' }) },
    {
      getCommand: async () => ({
        ...command,
        id: 'business',
        subjectId: 'other',
        receipt: { runId: 'run' },
      }),
    },
    { getCommand: async () => ({ ...command, id: 'business', receipt: { runId: 'other' } }) },
  ])
    await expect(readOrdinaryCommandApplication(client(patch), command)).rejects.toThrow();
  await expect(
    readOrdinaryCommandApplication(client(), {
      ...command,
      receipt: { ...(command.receipt as object), sourceCommandId: 'foreign' },
    }),
  ).rejects.toThrow();
});
test('observed ordinary Model closes progress with top level null Run and exact actual Model', async () => {
  const observation = {
    runId: 'run',
    executionId: 'model',
    messageId: 'message',
    answer: 'actual answer',
    clarification: null,
  };
  const progress = {
    ...command,
    receipt: { outcome: 'human_input_observed', runId: null, observation },
  };
  const actual = await readOrdinaryCommandApplication(client(), progress);
  expect(actual?.observation).toEqual(observation);
  await expect(
    readOrdinaryCommandApplication(
      client({
        getExecution: async () => ({
          id: 'model',
          kind: 'model',
          status: 'running',
          runId: 'run',
          sessionId: 's',
          originStoreId: 'store',
        }),
      }),
      progress,
    ),
  ).rejects.toThrow();
});
test('explicit applied control observation has no invented Run or answer', async () => {
  const actual = await readOrdinaryCommandApplication(
    client({
      getRun: () => {
        throw Error('unexpected');
      },
    }),
    { ...command, receipt: { outcome: 'human_input_observed', runId: null } },
  );
  expect(actual).toEqual({ run: null, sourceCommandId: 'public', observation: null });
});

test('accepted unresolved input exposes its exact sealed clarification without inventing a business Run', async () => {
  const observation = {
    runId: 'run',
    executionId: 'model',
    messageId: 'message',
    answer: null,
    clarification: '请说明当前输入属于哪项工作。\n完整原问题 😀',
  };
  const unresolved = {
    ...command,
    status: 'accepted',
    receipt: {
      outcome: 'human_input_unresolved',
      humanInputCommandId: 'raw',
      decisionCommandId: 'decision',
      businessCommandId: null,
      runId: null,
      observation,
    },
  } as Command;
  const actual = await readOrdinaryCommandApplication(client(), unresolved);
  expect(actual?.observation).toEqual(observation);
  expect(actual?.run).toEqual(run);
  expect(unresolved.status).toBe('accepted');
  expect((unresolved.receipt as { runId: null }).runId).toBeNull();
  for (const patch of [
    { getRun: async () => ({ ...run, sessionId: 'foreign' }) },
    {
      getExecution: async () => ({
        id: 'model',
        kind: 'model',
        status: 'succeeded',
        runId: 'run',
        sessionId: 's',
        originStoreId: 'foreign',
      }),
    },
  ])
    await expect(readOrdinaryCommandApplication(client(patch), unresolved)).rejects.toThrow();
  const invalidReceipts: Record<string, Json>[] = [
    { observation: null },
    { decisionCommandId: null },
    { humanInputCommandId: null },
    { runId: 'invented-business-run' },
    { businessCommandId: 'invented-business-command' },
  ];
  for (const patch of invalidReceipts)
    await expect(
      readOrdinaryCommandApplication(client(), {
        ...unresolved,
        receipt: { ...(unresolved.receipt as Record<string, Json>), ...patch },
      } as Command),
    ).rejects.toThrow();
  expect(
    await readOrdinaryCommandApplication(client(), {
      ...command,
      status: 'accepted',
      receipt: { outcome: 'human_input_pending', runId: null },
    } as Command),
  ).toBeNull();
});
