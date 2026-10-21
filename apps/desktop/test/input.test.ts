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

const publicWork: Command = {
  id: 'public',
  sessionId: 'a',
  subjectId: 'owner',
  kind: 'run.start',
  originStoreId: 'store',
  status: 'applied',
  receipt: {
    outcome: 'human_input_applied',
    businessCommandId: 'business',
    sourceCommandId: 'business',
    runId: 'business-run',
  },
  cancelRequestedAt: null,
};
const businessWork: Command = {
  ...publicWork,
  id: 'business',
  receipt: { runId: 'business-run' },
};
const businessRun: Run = {
  id: 'business-run',
  sessionId: 'a',
  originCommandId: 'business',
  originStoreId: 'store',
  rootWorkCommandId: 'public',
  rootWorkSeq: '1',
  status: 'completed',
  isActive: false,
  createdAt: 1,
  finishedAt: 2,
  reason: null,
};
function applicationFixture(
  options: {
    command?: Command;
    business?: Command;
    run?: Run;
    execution?: Record<string, unknown>;
  } = {},
) {
  const command = options.command ?? publicWork;
  const reads: string[] = [];
  let submissions = 0;
  let cancellations = 0;
  const submit = async () => {
    submissions++;
    return command;
  };
  const client = {
    serverInfo: {},
    startRun: submit,
    steer: submit,
    async getCommand(id: string) {
      reads.push(`command:${id}`);
      if (id === 'public') return command;
      if (id === 'business') return options.business ?? businessWork;
      throw Error('unexpected_command_read');
    },
    async getRun(id: string) {
      reads.push(`run:${id}`);
      return options.run ?? businessRun;
    },
    async getExecution(id: string) {
      reads.push(`execution:${id}`);
      return (
        options.execution ?? {
          id: 'model',
          kind: 'model',
          status: 'succeeded',
          runId: 'processing-run',
          sessionId: 'a',
          originStoreId: 'store',
        }
      );
    },
    async cancelCommand() {
      cancellations++;
      throw Error('unexpected_cancellation');
    },
  } as unknown as AgentClient;
  return {
    input: new DesktopInput({ admittedClient: client }),
    reads,
    get submissions() {
      return submissions;
    },
    get cancellations() {
      return cancellations;
    },
  };
}
const publicIntent = {
  kind: 'run.start' as const,
  commandId: 'public',
  expectedStoreId: 'store',
  content: 'New task: precise work',
};

test('lookup projects the exact applied business Run while preserving the public intent and root work', async () => {
  const f = applicationFixture();
  try {
    expect((await f.input.start('a', publicIntent)).phase).toBe('applied');
    const state = await f.input.lookup('public');
    expect(state).toMatchObject({
      phase: 'terminal',
      intent: publicIntent,
      command: publicWork,
      run: { ...businessRun, originCommandId: 'business', rootWorkCommandId: 'public' },
    });
    expect(f.reads).toEqual(['command:public', 'run:business-run', 'command:business']);
    expect((await f.input.lookup('public')).run).toEqual(businessRun);
    expect(f.submissions).toBe(1);
    expect(f.cancellations).toBe(0);
  } finally {
    f.input.disposeObserver();
  }
});

test('pending steer never becomes terminal merely because its original target Run has ended', async () => {
  const f = applicationFixture({
    command: {
      ...publicWork,
      kind: 'input.steer',
      status: 'accepted',
      receipt: { runId: businessRun.id },
    },
  });
  try {
    await f.input.steer('a', {
      ...publicIntent,
      kind: 'input.steer',
      targetRunId: businessRun.id,
      contextSelectionId: 'selection',
    });
    for (let i = 0; i < 2; i++) {
      const state = await f.input.lookup('public');
      expect(state.phase).toBe('accepted');
      expect(state.run).toBeUndefined();
    }
    expect(f.reads).toEqual(['command:public', 'command:public']);
    expect(f.submissions).toBe(1);
    expect(f.cancellations).toBe(0);
  } finally {
    f.input.disposeObserver();
  }
});

const observation = {
  runId: 'processing-run',
  executionId: 'model',
  messageId: 'message',
  answer: null,
  clarification: 'Which original work does this input concern?',
};
function observedCommand(unresolved: boolean): Command {
  return {
    ...publicWork,
    status: unresolved ? 'accepted' : 'applied',
    receipt: {
      outcome: unresolved ? 'human_input_unresolved' : 'human_input_observed',
      humanInputCommandId: 'raw',
      decisionCommandId: 'decision',
      businessCommandId: null,
      runId: null,
      observation,
    },
  };
}
const processingRun: Run = {
  ...businessRun,
  id: 'processing-run',
  originCommandId: 'processing',
  rootWorkCommandId: 'processing',
};

for (const unresolved of [false, true])
  test(`${unresolved ? 'accepted sealed clarification' : 'applied observation'} reads the exact Model without projecting a processing Run as business completion`, async () => {
    const command = observedCommand(unresolved);
    const f = applicationFixture({ command, run: processingRun });
    try {
      await f.input.start('a', publicIntent);
      const state = await f.input.lookup('public');
      expect(state.phase).toBe(unresolved ? 'accepted' : 'applied');
      expect(state.run).toBeUndefined();
      expect(state.command).toEqual(command);
      expect(f.reads).toEqual(['command:public', 'run:processing-run', 'execution:model']);
      expect(f.submissions).toBe(1);
      expect(f.cancellations).toBe(0);
    } finally {
      f.input.disposeObserver();
    }
  });

test('foreign or unapplied business receipts cannot attach another Run to the saved public input', async () => {
  const patches: Partial<Command>[] = [
    { id: 'foreign' },
    { originStoreId: 'foreign' },
    { sessionId: 'foreign' },
    { subjectId: 'foreign' },
    { status: 'accepted' },
    { receipt: { runId: 'foreign' } },
  ];
  for (const patch of patches) {
    const f = applicationFixture({ business: { ...businessWork, ...patch } });
    try {
      await f.input.start('a', publicIntent);
      await expect(f.input.lookup('public')).rejects.toThrow('ordinary_command_business_mismatch');
      expect(f.input.submissions[0]?.run).toBeUndefined();
      expect(f.submissions).toBe(1);
      expect(f.cancellations).toBe(0);
    } finally {
      f.input.disposeObserver();
    }
  }
});

test('foreign or unfinished observation Models are rejected without publishing a business Run or replaying input', async () => {
  for (const patch of [
    { originStoreId: 'foreign' },
    { sessionId: 'foreign' },
    { runId: 'foreign' },
    { status: 'running' },
    { kind: 'tool' },
  ]) {
    const f = applicationFixture({
      command: observedCommand(true),
      run: processingRun,
      execution: {
        id: 'model',
        kind: 'model',
        status: 'succeeded',
        runId: 'processing-run',
        sessionId: 'a',
        originStoreId: 'store',
        ...patch,
      },
    });
    try {
      await f.input.start('a', publicIntent);
      await expect(f.input.lookup('public')).rejects.toThrow(
        'ordinary_command_observation_mismatch',
      );
      expect(f.input.submissions[0]?.phase).toBe('accepted');
      expect(f.input.submissions[0]?.run).toBeUndefined();
      expect(f.submissions).toBe(1);
      expect(f.cancellations).toBe(0);
    } finally {
      f.input.disposeObserver();
    }
  }
});
