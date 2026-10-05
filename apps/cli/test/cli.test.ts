import { expect, test } from 'bun:test';
import type { AgentClient, Command } from '@kite-ai/client';
import { invokeExtension, runNonInteractive } from '../src';

const command: Command = {
  id: 'c',
  sessionId: 's',
  kind: 'extension.invoke',
  status: 'applied',
  receipt: { executionId: 'predecessor', preparingNextAttempt: true },
  originStoreId: 'store',
  cancelRequestedAt: null,
};
test('predecessor terminal cannot complete CLI while preparingNextAttempt remains set', async () => {
  let reads = 0;
  const client = {
    async invokeExtension() {
      return command;
    },
    async getCommand() {
      reads++;
      return reads < 2
        ? command
        : { ...command, receipt: { executionId: 'current', preparingNextAttempt: false } };
    },
    async getExecution(id: string) {
      return { id, sessionId: 's', status: 'succeeded' };
    },
  } as unknown as AgentClient;
  const lines: string[] = [];
  const result = await invokeExtension(
    's',
    {
      expectedStoreId: 'store',
      commandId: 'c',
      kind: 'extension.invoke',
      extensionId: 'external',
      actionId: 'analyze',
      definitionVersion: '1',
      input: {},
    },
    {
      client,
      write(line) {
        lines.push(line);
      },
      pollIntervalMs: 0,
    },
  );
  expect(reads).toBe(2);
  expect(result.exitCode).toBe(0);
  expect(lines).toEqual(['accepted c', 'terminal c succeeded']);
});

test('non-interactive entry rejects credentials on argv before business calls', async () => {
  const client = {} as AgentClient;
  await expect(
    runNonInteractive(['run', 's', '{}', '--token=secret'], { client, write() {} }),
  ).rejects.toThrow('invalid_cli_arguments');
});

test('lost acceptance queries original ID without resubmission and reports unknown execution separately', async () => {
  let mutations = 0;
  let reads = 0;
  const client = {
    async invokeExtension() {
      mutations++;
      throw new Error('response lost');
    },
    async getCommand(id: string) {
      reads++;
      expect(id).toBe('c');
      return { ...command, receipt: { executionId: 'e', preparingNextAttempt: false } };
    },
    async getExecution() {
      return { id: 'e', sessionId: 's', status: 'outcome_unknown' };
    },
  } as unknown as AgentClient;
  const result = await invokeExtension(
    's',
    {
      expectedStoreId: 'store',
      commandId: 'c',
      kind: 'extension.invoke',
      extensionId: 'external',
      actionId: 'analyze',
      definitionVersion: '1',
      input: {},
    },
    { client, write() {} },
  );
  expect(result.exitCode).toBe(2);
  expect(result.status).toBe('outcome_unknown');
  expect(mutations).toBe(1);
  expect(reads).toBe(2);
});

test('failed injected answer keeps a known unresolved request and sends no answer mutation', async () => {
  const { run } = await import('../src');
  const interaction = {
    id: 'i',
    originStoreId: 'store',
    sessionId: 's',
    presentationSessionId: 's',
    runId: 'r',
    revision: '1',
    kind: 'question',
    state: 'pending',
  };
  let mutations = 0;
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async startRun() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getCommand() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getRun() {
      return {
        id: 'r',
        originCommandId: 'c',
        originStoreId: 'store',
        sessionId: 's',
        isActive: true,
        status: 'waiting_interaction',
      };
    },
    async listInteractions() {
      return { interactions: [interaction], nextAfterId: null };
    },
    async answerInteraction() {
      mutations++;
    },
  } as unknown as AgentClient;
  const result = await run(
    's',
    { kind: 'run.start', expectedStoreId: 'store', commandId: 'c', content: 'test' },
    {
      client,
      write() {},
      answerInteraction: async () => {
        throw new Error('input failed');
      },
    },
  );
  expect(result.status).toBe('waiting_interaction');
  expect(result.interactions?.[0]?.id).toBe('i');
  expect(mutations).toBe(0);
});

test('Ctrl+C wakes injected waiting handler and cancels only the saved work command', async () => {
  const { run } = await import('../src');
  const controller = new AbortController();
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async startRun() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getCommand() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getRun() {
      return {
        id: 'r',
        originCommandId: 'c',
        originStoreId: 'store',
        sessionId: 's',
        isActive: !cancelled,
        status: cancelled ? 'cancelled' : 'waiting_interaction',
      };
    },
    async listInteractions() {
      return {
        interactions: [
          {
            id: 'i',
            originStoreId: 'store',
            sessionId: 's',
            presentationSessionId: 's',
            runId: 'r',
            revision: '1',
            kind: 'question',
            state: 'pending',
          },
        ],
        nextAfterId: null,
      };
    },
    async cancelCommand(
      session: string,
      input: { targetCommandId: string; expectedStoreId: string },
    ) {
      expect(session).toBe('s');
      expect(input.targetCommandId).toBe('c');
      expect(input.expectedStoreId).toBe('store');
      cancelled = true;
    },
  } as unknown as AgentClient;
  const result = await run(
    's',
    { kind: 'run.start', expectedStoreId: 'store', commandId: 'c', content: 'test' },
    {
      client,
      write() {},
      signal: controller.signal,
      pollIntervalMs: 0,
      answerInteraction: async (_interaction, context) => {
        signal = context.signal;
        controller.abort();
        return new Promise(() => {});
      },
    },
  );
  expect(result.status).toBe('cancelled');
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

test('CLI plan handler cannot submit Full or missing explicit mode, and preserves exact pending information request', async () => {
  const { run } = await import('../src');
  let mutations = 0;
  const card = {
    id: 'plan',
    originStoreId: 'store',
    sessionId: 's',
    presentationSessionId: 's',
    runId: 'r',
    revision: '1',
    kind: 'plan_review',
    state: 'pending',
    request: {
      planId: 'p',
      version: 'v1',
      digest: 'digest',
      content: 'body',
      allowedModes: ['auto', 'accept_edits'],
    },
  };
  const client = {
    serverInfo: { capabilities: ['interactions'] },
    async startRun() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getCommand() {
      return { ...command, kind: 'run.start', receipt: { runId: 'r' } };
    },
    async getRun() {
      return {
        id: 'r',
        originCommandId: 'c',
        originStoreId: 'store',
        sessionId: 's',
        isActive: true,
        status: 'waiting_interaction',
      };
    },
    async listInteractions() {
      return { interactions: [card], nextAfterId: null };
    },
    async answerInteraction() {
      mutations++;
    },
  } as unknown as AgentClient;
  for (const mode of [undefined, 'full']) {
    const result = await run(
      's',
      { kind: 'run.start', expectedStoreId: 'store', commandId: 'c', content: 'test' },
      {
        client,
        write() {},
        answerInteraction: async () => ({
          kind: 'plan_review',
          decision: 'approve',
          ...(mode ? { mode } : {}),
        }),
      },
    );
    expect(result.status).toBe('waiting_interaction');
    expect(result.interactions?.[0]?.id).toBe('plan');
  }
  expect(mutations).toBe(0);
});

test('Workflow follow-up loses acceptance and only reads the original stable intent', async () => {
  const { run, observeCommand } = await import('../src');
  let posts = 0,
    reads = 0;
  const input = {
    kind: 'input.follow_up' as const,
    expectedStoreId: 'store',
    commandId: 'follow',
    afterRunId: 'held',
    contextSelectionId: 'selection',
    content: 'original task',
    selectedSkills: ['guide'],
    extensionInputs: [
      {
        extensionId: 'builtin.skill-workflow',
        definitionVersion: '1',
        input: { activations: [{ key: 'manual-1', skillId: 'skill:alpha-skill', input: {} }] },
      },
    ],
  };
  const snapshot = structuredClone(input);
  const client = {
    async followUp(sessionId: string, value: unknown) {
      posts++;
      expect(sessionId).toBe('s');
      expect(value).toEqual(snapshot);
      throw Error('lost');
    },
    async getCommand(id: string) {
      reads++;
      expect(id).toBe('follow');
      return {
        ...command,
        id: 'follow',
        kind: 'input.follow_up',
        status: 'applied',
        receipt: { runId: 'next' },
      };
    },
    async getRun() {
      return {
        id: 'next',
        sessionId: 's',
        originStoreId: 'store',
        originCommandId: 'follow',
        isActive: false,
        status: 'completed',
      };
    },
  } as unknown as AgentClient;
  expect((await run('s', input, { client, write() {} })).exitCode).toBe(0);
  expect((await observeCommand('s', input, { client, write() {} })).exitCode).toBe(0);
  expect(input).toEqual(snapshot);
  expect(posts).toBe(1);
  expect(reads).toBe(4);
});
test('follow-up original lookup with wrong command kind remains unknown', async () => {
  const { run } = await import('../src');
  let posts = 0;
  const client = {
    async followUp() {
      posts++;
      throw Error('lost');
    },
    async getCommand() {
      return { ...command, id: 'follow', kind: 'run.start', receipt: { runId: 'wrong' } };
    },
  } as unknown as AgentClient;
  const outcome = await run(
    's',
    {
      kind: 'input.follow_up',
      expectedStoreId: 'store',
      commandId: 'follow',
      afterRunId: 'held',
      contextSelectionId: 'selection',
      content: 'task',
    },
    { client, write() {} },
  );
  expect(outcome.status).toBe('outcome_unknown');
  expect(posts).toBe(1);
});
