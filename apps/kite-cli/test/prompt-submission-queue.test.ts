import { expect, test } from 'bun:test';
import {
  ensureTuiPromptSession,
  observeTuiPromptSubmission,
  TuiPromptSubmissionQueue,
} from '../src/tui/prompt-submission-queue';

test('TUI prompt session creates the initial Runtime synchronously when startup effect has not run', () => {
  const created: string[] = [];
  const resolution = ensureTuiPromptSession({
    submittedSessionId: '',
    getActiveSessionId: () => '',
    createSession: () => {
      created.push('session-created');
      return 'session-created';
    },
  });

  expect(resolution).toEqual({ sessionId: 'session-created', created: true });
  expect(created).toEqual(['session-created']);
});

test('TUI prompt session preserves a submitted identity and reuses an existing startup Session', () => {
  let createCalls = 0;
  const createSession = () => {
    createCalls += 1;
    return 'unexpected';
  };

  expect(
    ensureTuiPromptSession({
      submittedSessionId: 'submitted-session',
      getActiveSessionId: () => 'new-foreground-session',
      createSession,
    }),
  ).toEqual({ sessionId: 'submitted-session', created: false });
  expect(
    ensureTuiPromptSession({
      submittedSessionId: '',
      getActiveSessionId: () => 'startup-session',
      createSession,
    }),
  ).toEqual({ sessionId: 'startup-session', created: false });
  expect(createCalls).toBe(0);
});

test('TUI prompt queue preserves per-Session FIFO without blocking another Session', async () => {
  const queue = new TuiPromptSubmissionQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue('session-a', async (sessionId) => {
    order.push(`start:${sessionId}:first`);
    await firstBarrier;
    order.push(`finish:${sessionId}:first`);
  });
  const second = queue.enqueue('session-a', async (sessionId) => {
    order.push(`run:${sessionId}:second`);
  });
  const third = queue.enqueue('session-b', async (sessionId) => {
    order.push(`run:${sessionId}:third`);
  });

  await Bun.sleep(0);
  expect(order).toEqual(['start:session-a:first', 'run:session-b:third']);
  expect(queue.hasPending('session-a')).toBe(true);
  expect(queue.hasPending('session-b')).toBe(false);
  releaseFirst();
  await Promise.all([first, second, third]);
  expect(order).toEqual([
    'start:session-a:first',
    'run:session-b:third',
    'finish:session-a:first',
    'run:session-a:second',
  ]);
  expect(queue.hasPending('session-a')).toBe(false);
});

test('TUI prompt queue exposes a submission failure without poisoning later prompts', async () => {
  const queue = new TuiPromptSubmissionQueue();
  const failure = queue.enqueue('session-a', async () => {
    throw new Error('submission rejected');
  });
  const successor = queue.enqueue('session-b', async (sessionId) => sessionId);

  await expect(failure).rejects.toThrow('submission rejected');
  await expect(successor).resolves.toBe('session-b');
});

test('TUI prompt submission makes queued acceptance and eventual failure observable', async () => {
  const observations: string[] = [];
  let rejectSubmission!: (error: Error) => void;
  const submission = new Promise<void>((_resolve, reject) => {
    rejectSubmission = reject;
  });

  observeTuiPromptSubmission({
    queued: true,
    submit: () => submission,
    onQueued: () => observations.push('queued'),
    onFailure: (error) =>
      observations.push(`failed:${error instanceof Error ? error.message : String(error)}`),
  });

  expect(observations).toEqual(['queued']);
  rejectSubmission(new Error('revision_conflict'));
  await Bun.sleep(0);
  expect(observations).toEqual(['queued', 'failed:revision_conflict']);
});

test('TUI prompt submission also converts a synchronous submit fault into visible failure', async () => {
  const failures: string[] = [];

  observeTuiPromptSubmission({
    queued: false,
    submit: () => {
      throw new Error('synchronous failure');
    },
    onQueued: () => {
      throw new Error('idle submission must not report queued');
    },
    onFailure: (error) => failures.push(error instanceof Error ? error.message : String(error)),
  });

  await Bun.sleep(0);
  expect(failures).toEqual(['synchronous failure']);
});
