import { expect, test } from 'bun:test';
import { type AgentClient, ClientError, type Command, type Run } from '@kite-ai/client';
import { DesktopInput, type InputSubmission } from '../src/input';

test('intent-only transport response loss and a full work cache preserve precise cancellation slots', async () => {
  let sends = 0,
    cancelSends = 0;
  const commands = new Map<string, Command>();
  const command = (
    sessionId: string,
    input: { commandId: string; kind: string; expectedStoreId: string },
  ): Command => ({
    id: input.commandId,
    sessionId,
    kind: input.kind,
    originStoreId: input.expectedStoreId,
    status: 'accepted',
    receipt: null,
    cancelRequestedAt: null,
  });
  const client = {
    serverInfo: {},
    async startRun(
      sessionId: string,
      input: { commandId: string; kind: string; expectedStoreId: string },
    ) {
      sends++;
      commands.set(input.commandId, command(sessionId, input));
      throw new Error('lost');
    },
    async cancelCommand(
      sessionId: string,
      input: { commandId: string; kind: string; expectedStoreId: string },
    ) {
      cancelSends++;
      const value = command(sessionId, input);
      commands.set(input.commandId, value);
      return value;
    },
    async getCommand(id: string) {
      return commands.get(id)!;
    },
  } as unknown as AgentClient;
  const input = new DesktopInput({ admittedClient: client, maxIntents: 1 });
  const work = {
    kind: 'run.start' as const,
    expectedStoreId: 'original',
    commandId: 'work',
    content: 'task',
  };
  expect((await input.start('a', work)).phase).toBe('unknown');
  expect((await input.start('a', work)).phase).toBe('unknown');
  expect(sends).toBe(1);
  expect(() => input.start('b', { ...work, commandId: 'more' })).toThrow('input_intent_limit');
  const cancel = input.cancel('work', 'cancel');
  expect(input.cancel('work', 'different-click')).toBe(cancel);
  expect((await cancel).intent).toMatchObject({
    expectedStoreId: 'original',
    targetCommandId: 'work',
  });
  expect(cancelSends).toBe(1);
  expect((await input.lookup('work')).command?.originStoreId).toBe('original');
  expect((await input.lookup('cancel')).phase).toBe('accepted');
  input.disposeObserver();
});

test('local admission failure is known; disposal aborts only owned reads and never sends cancel or replays work', async () => {
  let aborted = false,
    sends = 0;
  const callbacks: InputSubmission[] = [];
  const client = {
    serverInfo: {},
    async startRun() {
      sends++;
      throw new ClientError('capability_unavailable');
    },
    async getCommand(_id: string, options: { signal: AbortSignal }) {
      await new Promise((_resolve, reject) =>
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('observer_disposed'));
          },
          { once: true },
        ),
      );
    },
  } as unknown as AgentClient;
  const input = new DesktopInput({
    admittedClient: client,
    onSubmission: (state) => callbacks.push(state),
  });
  const work = {
    kind: 'run.start' as const,
    expectedStoreId: 'store',
    commandId: 'work',
    content: 'task',
  };
  expect((await input.start('a', work)).phase).toBe('failed');
  const read = input.lookup('work');
  await Promise.resolve();
  input.disposeObserver();
  await expect(read).rejects.toThrow('observer_disposed');
  expect(aborted).toBe(true);
  expect(sends).toBe(1);
  expect(callbacks.at(-1)?.phase).toBe('failed');
  expect(() => input.start('a', work)).toThrow('input_disposed');
});

test('an older delayed lookup cannot overwrite a newer actual terminal projection', async () => {
  const command: Command = {
    id: 'work',
    sessionId: 'a',
    kind: 'run.start',
    originStoreId: 'store',
    status: 'applied',
    receipt: { runId: 'run' },
    cancelRequestedAt: null,
  };
  const running: Run = {
    id: 'run',
    sessionId: 'a',
    originCommandId: 'work',
    originStoreId: 'store',
    status: 'running',
    isActive: true,
    createdAt: 1,
    finishedAt: null,
    reason: null,
  };
  let release!: () => void,
    reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    serverInfo: {},
    async startRun() {
      return command;
    },
    async getCommand() {
      return command;
    },
    async getRun() {
      if (reads++ === 0) {
        await gate;
        return running;
      }
      return { ...running, status: 'completed', isActive: false, finishedAt: 2 };
    },
  } as unknown as AgentClient;
  const input = new DesktopInput({ admittedClient: client });
  await input.start('a', {
    kind: 'run.start',
    commandId: 'work',
    expectedStoreId: 'store',
    content: 'task',
  });
  const old = input.lookup('work');
  await Promise.resolve();
  expect((await input.lookup('work')).phase).toBe('terminal');
  release();
  expect((await old).run?.status).toBe('completed');
  expect(input.submissions[0]?.run?.isActive).toBe(false);
  input.disposeObserver();
});
