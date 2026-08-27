import { expect, test } from 'bun:test';
import {
  observeTuiPromptSubmission,
  TuiPromptSubmissionQueue,
} from '../src/tui/prompt-submission-queue';

test('TUI prompt queue preserves FIFO order and the enqueue-time Session identity', async () => {
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
  expect(order).toEqual(['start:session-a:first']);
  releaseFirst();
  await Promise.all([first, second, third]);
  expect(order).toEqual([
    'start:session-a:first',
    'finish:session-a:first',
    'run:session-a:second',
    'run:session-b:third',
  ]);
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
