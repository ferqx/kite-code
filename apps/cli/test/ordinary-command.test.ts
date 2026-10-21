import { expect, test } from 'bun:test';
import type { AgentClient, Command } from '@kite-ai/client';
import { observeCommand, run } from '../src';

const publicCommand = {
  id: 'public',
  kind: 'run.start',
  status: 'applied',
  sessionId: 's',
  originStoreId: 'store',
  subjectId: 'user',
  cancelRequestedAt: null,
  receipt: {
    outcome: 'human_input_applied',
    businessCommandId: 'business',
    sourceCommandId: 'business',
    runId: 'run',
  },
} as Command;
test('CLI ordinary input waits for the actual business Run and submits public intent once', async () => {
  let posts = 0,
    reads = 0;
  const lines: string[] = [];
  const client = {
    startRun: async () => {
      posts++;
      return publicCommand;
    },
    getCommand: async (id: string) =>
      id === 'public'
        ? publicCommand
        : { ...publicCommand, id: 'business', receipt: { runId: 'run' } },
    getRun: async () => {
      reads++;
      return {
        id: 'run',
        originCommandId: 'business',
        sessionId: 's',
        originStoreId: 'store',
        isActive: reads < 2,
        status: reads < 2 ? 'running' : 'completed',
      };
    },
  } as unknown as AgentClient;
  const outcome = await run(
    's',
    { kind: 'run.start', commandId: 'public', expectedStoreId: 'store', content: 'actual work' },
    { client, write: (line) => lines.push(line), pollIntervalMs: 0 },
  );
  expect(outcome.exitCode).toBe(0);
  expect(posts).toBe(1);
  expect(reads).toBe(2);
  expect(lines).toEqual(['accepted public', 'terminal public succeeded']);
});
test('CLI observed progress finishes from saved Model even while its Run remains active', async () => {
  let posts = 0;
  let reads = 0;
  const observed = {
    ...publicCommand,
    receipt: {
      outcome: 'human_input_observed',
      runId: null,
      observation: {
        runId: 'run',
        executionId: 'model',
        messageId: 'message',
        answer: 'Saved progress',
        clarification: null,
      },
    },
  };
  const client = {
    startRun: async () => {
      posts++;
      return observed;
    },
    getCommand: async () => observed,
    getRun: async () => {
      reads++;
      return {
        id: 'run',
        originCommandId: 'old-business',
        sessionId: 's',
        originStoreId: 'store',
        isActive: true,
        status: 'running',
      };
    },
    getExecution: async () => ({
      id: 'model',
      kind: 'model',
      status: 'succeeded',
      runId: 'run',
      sessionId: 's',
      originStoreId: 'store',
    }),
  } as unknown as AgentClient;
  const outcome = await run(
    's',
    { kind: 'run.start', commandId: 'public', expectedStoreId: 'store', content: 'progress?' },
    { client, write() {}, pollIntervalMs: 0 },
  );
  expect(outcome.exitCode).toBe(0);
  expect(posts).toBe(1);
  expect(reads).toBe(1);
});

test('technical handoff completion never reports business work succeeded', async () => {
  const client = {
    startRun: async () => publicCommand,
    getCommand: async (id: string) =>
      id === 'public'
        ? publicCommand
        : { ...publicCommand, id: 'business', receipt: { runId: 'run' } },
    getRun: async () => ({
      id: 'run',
      originCommandId: 'business',
      sessionId: 's',
      originStoreId: 'store',
      isActive: false,
      status: 'completed',
      reason: 'human_work_deferred',
    }),
  } as unknown as AgentClient;
  const result = await run(
    's',
    { kind: 'run.start', commandId: 'public', expectedStoreId: 'store', content: 'work' },
    { client, write() {}, pollIntervalMs: 0 },
  );
  expect(result.status).toBe('outcome_unknown');
  expect(result.exitCode).toBe(2);
});

test('CLI returns an accepted sealed clarification as waiting input and observes the same invocation without submitting again', async () => {
  const clarification = '请明确这条输入属于哪项工作。\n完整保留 😀 与首尾空格  ';
  const unresolved = {
    ...publicCommand,
    status: 'accepted',
    receipt: {
      outcome: 'human_input_unresolved',
      humanInputCommandId: 'raw',
      decisionCommandId: 'decision',
      runId: null,
      businessCommandId: null,
      observation: {
        runId: 'processing',
        executionId: 'model',
        messageId: 'message',
        answer: null,
        clarification,
      },
    },
  } as Command;
  let posts = 0;
  const client = {
    startRun: async () => {
      posts++;
      return unresolved;
    },
    getCommand: async () => unresolved,
    getRun: async () => ({
      id: 'processing',
      originCommandId: 'input-processing',
      sessionId: 's',
      originStoreId: 'store',
      isActive: false,
      status: 'completed',
    }),
    getExecution: async () => ({
      id: 'model',
      kind: 'model',
      status: 'succeeded',
      runId: 'processing',
      sessionId: 's',
      originStoreId: 'store',
    }),
  } as unknown as AgentClient;
  const intent = {
    kind: 'run.start' as const,
    commandId: 'public',
    expectedStoreId: 'store',
    content: '先处理一下',
  };
  for (const execute of [run, observeCommand]) {
    const lines: string[] = [];
    const outcome = await execute('s', intent, {
      client,
      write: (line) => lines.push(line),
      pollIntervalMs: 0,
      timeoutMs: 100,
    });
    expect(outcome.status).toBe('needs_clarification');
    expect(outcome.exitCode).toBe(3);
    expect((unresolved.receipt as { observation: unknown }).observation).toEqual(
      outcome.clarification,
    );
    expect(Object.hasOwn(JSON.parse(JSON.stringify(outcome)), 'run')).toBe(false);
    expect(lines.some((line) => line.includes('public'))).toBe(true);
    const output = lines.join('\n');
    expect(output.includes(clarification) || output.includes(JSON.stringify(clarification))).toBe(
      true,
    );
    expect(output).not.toContain('terminal public succeeded');
  }
  expect(posts).toBe(1);
  expect(unresolved.status).toBe('accepted');
});
