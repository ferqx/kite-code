import { expect, test } from 'bun:test';
import type { Command, Interaction, PendingInputPage, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';
import { callerTarget, type TuiCallerIntent, type TuiCallerRequest } from '../../src/tui/caller';

const tick = () => Bun.sleep(25);
function fixture() {
  let next = 0,
    snapshot: TuiSnapshot;
  const snapshots = new Map<string, TuiSnapshot>();
  const cancels: string[] = [],
    quits: string[] = [],
    posts: string[] = [];
  const fresh = (id: string): TuiSnapshot => ({
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'workspace',
        rootSessionId: id,
        parentSessionId: null,
        title: id,
        contextSelectionId: 'selection',
        controlRevision: '0',
        nextSeq: '0',
        deletedAt: null,
      },
      runs: [
        {
          id: `${id}-run`,
          sessionId: id,
          originStoreId: 'store',
          originCommandId: `${id}-work`,
          status: 'running',
          isActive: true,
          createdAt: 1,
          finishedAt: null,
          reason: null,
        },
      ],
      executions: [],
      messages: [],
    } as SessionView,
    messages: [],
    interactions: [],
    pendingInputs: [],
  });
  snapshot = fresh('a');
  snapshots.set('a', snapshot);
  snapshots.set('b', fresh('b'));
  const command = (id: string, sessionId: string, kind: string): Command => ({
    id,
    sessionId,
    kind,
    originStoreId: 'store',
    status: 'accepted',
    receipt: {},
    cancelRequestedAt: null,
  });
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `command-${++next}`,
    listSessions: async () => [],
    readSession: async (id) => snapshots.get(id)!,
    cancel: async (session, request) => {
      cancels.push(request.targetCommandId);
      return command(request.commandId, session, request.kind);
    },
    submit: async (_session, request) => {
      posts.push(request.content);
      throw Error('lost original response');
    },
    answer: async () => {
      throw Error('No answer is authorized by these key presses');
    },
    getCommand: async () => {
      throw Error('No lookup gesture');
    },
  };
  const controller = new TuiController(port);
  return {
    snapshot,
    snapshots,
    port,
    controller,
    cancels,
    posts,
    quits,
    app: () =>
      render(
        <TuiSession controller={controller} onQuit={() => quits.push(controller.state.draft)} />,
      ),
  };
}

test('Esc respects candidates; ordinary cancellation and explicit double Ctrl+C retain the original draft and quit host once', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.controller.setDraft('/mo');
  const app = f.app();
  try {
    await tick();
    app.stdin.write('\u001b');
    await tick();
    expect(f.cancels).toEqual([]);
    expect(f.controller.state.draft).toBe('/mo');
    app.stdin.write('\u001b');
    await tick();
    expect(f.cancels).toEqual(['a-work']);
    f.controller.setDraft('kept 中文👩‍💻');
    await tick();
    app.stdin.write('\u0003\u0003');
    await tick();
    app.stdin.write('\u0003');
    await tick();
    expect(f.quits).toEqual([]);
    app.stdin.write('\u0003');
    await tick();
    expect(f.quits).toEqual(['kept 中文👩‍💻']);
    expect(f.cancels).toEqual(['a-work']);
    expect(f.posts).toEqual([]);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('whole-task cancellation targets the active original Run even after a persisted follow-up caller, preserving that queued intent', async () => {
  const f = fixture();
  const scope = { storeId: 'store', workspaceId: 'workspace', sessionId: 'a' };
  const intent = (request: TuiCallerRequest): TuiCallerIntent => ({
    scope,
    request,
    target: callerTarget(scope, request),
    subjectId: 'subject',
    bodyDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
  });
  const followUp = intent({
    expectedStoreId: 'store',
    commandId: 'queued',
    kind: 'input.follow_up',
    content: 'keep this next task',
    afterRunId: 'a-run',
    contextSelectionId: 'selection',
  });
  const submitted: TuiCallerIntent[] = [];
  f.port.callers = {
    list: async () => [{ intent: followUp, phase: 'accepted' }],
    prepare: async (_scope, request) => intent(request),
    submit: async (original) => {
      submitted.push(original);
      return {
        intent: original,
        phase: 'accepted',
        command: {
          id: original.request.commandId,
          sessionId: 'a',
          originStoreId: 'store',
          kind: original.request.kind,
          status: 'accepted',
          receipt: {},
          cancelRequestedAt: null,
        },
      };
    },
    lookup: async () => {
      throw Error('no GET gesture');
    },
    clear: async () => {
      throw Error('whole-task cancel must retain the queued intent');
    },
  };
  await f.controller.restoreCallers();
  await f.controller.select('a');
  await f.controller.cancel();
  await f.controller.cancel();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.request).toMatchObject({
    kind: 'command.cancel',
    targetCommandId: 'a-work',
  });
  expect(submitted[0]?.scope).toEqual(scope);
  expect(
    [...f.controller.state.callers.values()].some(
      (row) => row.intent.request.commandId === 'queued',
    ),
  ).toBe(true);
  f.controller.dispose();
});

test('ordinary main transcript keeps exact same-name calls, source-ordered results and intermediate-card navigation without writing', async () => {
  const f = fixture();
  const execution = (id: string, text: string) => ({
    id,
    originStoreId: 'store',
    sessionId: 'a',
    runId: 'a-run',
    kind: 'tool' as const,
    definitionId: 'same-tool',
    definitionVersion: '1',
    status: 'succeeded' as const,
    resultRevision: '1',
    cancelRequestedAt: null,
    result: { text, values: [false, null] },
  });
  f.snapshot.view.executions = [
    execution('private-first', 'first result'),
    execution('private-second', 'second result'),
  ];
  Object.assign(f.snapshot, {
    messages: [
      {
        id: 'start',
        sessionId: 'a',
        runId: 'a-run',
        seq: '1',
        role: 'user',
        status: 'complete',
        content: 'original task',
      },
      {
        id: 'model-message',
        sessionId: 'a',
        runId: 'a-run',
        seq: '2',
        role: 'assistant',
        status: 'complete',
        content: 'before tools',
        toolCalls: [
          {
            id: 'first-call',
            name: 'same-tool',
            arguments: '{"original":"first","flags":[false,null]}',
          },
          { id: 'second-call', name: 'same-tool', arguments: '{"original":"second"}' },
        ],
      },
      {
        id: 'result-one',
        sessionId: 'a',
        runId: 'a-run',
        seq: '3',
        role: 'tool',
        status: 'complete',
        content: 'first result',
        toolCallId: 'first-call',
        sourceIds: ['private-first'],
      },
      {
        id: 'result-two',
        sessionId: 'a',
        runId: 'a-run',
        seq: '4',
        role: 'tool',
        status: 'complete',
        content: 'second result',
        toolCallId: 'second-call',
        sourceIds: ['private-second'],
      },
      {
        id: 'answer',
        sessionId: 'a',
        runId: 'a-run',
        seq: '5',
        role: 'assistant',
        status: 'complete',
        content: 'final reply',
      },
    ],
  });
  const unexpectedRead = async () => {
    throw Error('navigation is local');
  };
  f.port.executions = {
    getExecution: unexpectedRead,
    output: unexpectedRead,
    getView: unexpectedRead,
    getRun: unexpectedRead,
    messages: unexpectedRead,
    modelOutput: unexpectedRead,
    stop: unexpectedRead,
    getCommand: unexpectedRead,
  };
  await f.controller.select('a');
  const app = f.app();
  try {
    await tick();
    const frame = app.lastFrame()!;
    for (const body of [
      '"original":"first"',
      '"original":"second"',
      '[false,null]',
      'first result',
      'second result',
    ])
      expect(frame).toContain(body);
    expect(frame.indexOf('first result')).toBeLessThan(frame.indexOf('second result'));
    expect(frame.indexOf('before tools')).toBeLessThan(frame.indexOf('"original":"first"'));
    expect(frame.indexOf('"original":"first"')).toBeLessThan(frame.indexOf('first result'));
    expect(frame.indexOf('second result')).toBeLessThan(frame.indexOf('final reply'));
    expect(frame).not.toContain('private-first');
    app.stdin.write('\u0005');
    await tick();
    expect(f.controller.state.panel).toBe('executions');
    expect(f.controller.state.executionSelectedId).toBe('private-second');
    app.stdin.write('\u001b[A');
    await tick();
    expect(app.lastFrame()).toContain('first result');
    app.stdin.write('o');
    app.stdin.write('c');
    app.stdin.write('s');
    await tick();
    expect(f.controller.state.executionReading).toBeUndefined();
    expect(f.posts).toEqual([]);
    expect(f.cancels).toEqual([]);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('ShiftTab changes only the next draft in help and original pending-card focus, and Session switch clears the exit gesture', async () => {
  const f = fixture();
  await f.controller.select('a');
  const app = f.app();
  try {
    await tick();
    await f.controller.routeCommand('/help');
    await tick();
    app.stdin.write('\u001b[Z');
    await tick();
    expect(f.controller.state.planning).toBe(true);
    expect(f.controller.state.panel).toBe('help');
    f.controller.closePanel();
    Object.assign(f.snapshot, {
      interactions: [
        {
          id: 'approval',
          kind: 'approval',
          state: 'pending',
          revision: '1',
          originStoreId: 'store',
          sessionId: 'a',
          presentationSessionId: 'a',
          executionId: 'tool',
          runId: 'a-run',
          request: { description: 'Original decision' },
        } as unknown as Interaction,
      ],
    });
    await f.controller.select('a');
    await tick();
    app.stdin.write('\u001b[Z');
    await tick();
    expect(f.controller.state.planning).toBe(false);
    expect(f.posts).toEqual([]);
    app.stdin.write('\u0003');
    await tick();
    await f.controller.select('b');
    await tick();
    app.stdin.write('\u0003');
    await tick();
    expect(f.quits).toEqual([]);
    expect(f.cancels).toEqual(['a-work', 'b-work']);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('Session chooser owns keys while a Plan review waits; navigation never answers the hidden original card', async () => {
  const f = fixture(),
    answers: string[] = [];
  Object.assign(f.snapshot, {
    interactions: [
      {
        id: 'plan',
        kind: 'plan_review',
        state: 'pending',
        revision: '1',
        originStoreId: 'store',
        sessionId: 'a',
        presentationSessionId: 'a',
        runId: 'a-run',
        executionId: 'review',
        request: { allowedModes: ['auto'] },
      } as unknown as Interaction,
    ],
  });
  f.port.answer = async (_id, _interaction, request) => {
    answers.push(request.commandId);
    throw Error('chooser never authorizes an answer');
  };
  f.port.listSessions = async () => [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ];
  await f.controller.select('a');
  const app = f.app();
  try {
    await tick();
    app.stdin.write('\u0012');
    await tick();
    app.stdin.write('\u001b[B');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(answers).toEqual([]);
    expect(f.posts).toEqual([]);
    expect(f.cancels).toEqual([]);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('pending inputs are actual accepted directory facts; beginning work removes them and unknown local submission never becomes a queue', async () => {
  const f = fixture();
  Object.assign(f.snapshot, {
    pendingInputs: ['first\n完整后继', 'second🙂'].map(
      (content, index): PendingInputPage['commands'][number] => ({
        id: `pending-${index}`,
        sessionId: 'a',
        originStoreId: 'store',
        kind: 'input.follow_up',
        status: 'accepted',
        receipt: {},
        cancelRequestedAt: null,
        seq: String(index + 1),
        request: {
          kind: 'input.follow_up',
          content,
          afterRunId: 'a-run',
          contextSelectionId: 'selection',
        },
      }),
    ),
  });
  await f.controller.select('a');
  const app = f.app();
  try {
    await tick();
    expect(app.lastFrame()).toContain('完整后继');
    expect(app.lastFrame()).toContain('second🙂');
    await f.controller.select('b');
    await tick();
    expect(app.lastFrame()).not.toContain('second🙂');
    Object.assign(f.snapshot, { pendingInputs: [] });
    await f.controller.select('a');
    await tick();
    expect(app.lastFrame()).not.toContain('Follow-up waiting');
    f.controller.setDraft('unknown local input');
    await f.controller.send();
    await tick();
    expect(f.controller.state.intent?.phase).toBe('unknown');
    expect(f.posts).toEqual(['unknown local input']);
    expect(app.lastFrame()).not.toContain('Pending inputs');
    expect(f.cancels).toEqual([]);
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});
