import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink';
import { render as renderFrames } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
function snapshot(sessionId: string, bodies: readonly string[]): TuiSnapshot {
  return {
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id: sessionId,
        workspaceId: 'w',
        parentSessionId: null,
        rootSessionId: sessionId,
        title: sessionId,
        controlRevision: '0',
        contextSelectionId: 'selection',
        nextSeq: '9',
        deletedAt: null,
      },
      runs: [],
      executions: [],
      messages: [],
    } as SessionView,
    messages: bodies.map((content, index) => ({
      id: `message-${index}`,
      sessionId,
      runId: null,
      seq: String(index + 1),
      status: 'complete',
      role: 'assistant',
      content,
    })),
    interactions: [],
  };
}

test('interactive Ink emits completed bodies once across status/edit/append and replaces only semantic display generations', async () => {
  let bodies = [Array.from({ length: 60 }, (_, i) => `HISTORY_${i}_END`).join('\n\n')];
  const forbidden = async () => {
    throw new Error('read-only renderer must not submit');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async (id) => snapshot(id, bodies),
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const controller = new TuiController(port);
  await controller.select('a');
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  let bytes = '';
  stdout.on('data', (data) => {
    bytes += data.toString();
  });
  const app = render(<TuiSession controller={controller} />, {
    // Model only the Ink stream surface; actual PTY/VT behavior has separate evidence.
    stdout: stdout as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    stderr: new PassThrough() as unknown as WriteStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await pause();
    expect(bytes.split('HISTORY_59_END')).toHaveLength(2);
    bytes = '';
    controller.observationUnavailable('bounded-status');
    await pause();
    expect(bytes).toContain('Stale');
    expect(bytes).not.toContain('HISTORY_');
    expect(bytes).not.toContain('\u001b[2J');
    expect(bytes).not.toContain('\u001b[3J');
    bytes = '';
    controller.setDraft('editing preserved');
    await pause();
    expect(bytes).toContain('editing preserved');
    expect(bytes).not.toContain('HISTORY_');
    expect(bytes).not.toContain('\u001b[2J');
    bodies = [...bodies, 'SECOND_COMPLETED_BODY'];
    bytes = '';
    await controller.select('a');
    await pause();
    expect(bytes.split('SECOND_COMPLETED_BODY')).toHaveLength(2);
    expect(bytes).not.toContain('HISTORY_');
    bytes = '';
    controller.clearDisplay();
    await pause();
    expect(bytes).toContain('\u001b[3J');
    expect(bytes).toContain('Session');
    expect(bytes).toContain('New Run');
    expect(controller.state.snapshot?.messages).toHaveLength(2);
    bytes = '';
    await controller.select('a');
    await pause();
    expect(bytes).not.toContain('HISTORY_');
    expect(bytes).not.toContain('SECOND_COMPLETED_BODY');
    bodies = [bodies[0]!, 'CHANGED_COMPLETED_BODY'];
    bytes = '';
    await controller.select('a');
    await pause();
    expect(bytes.split('CHANGED_COMPLETED_BODY')).toHaveLength(2);
    expect(bytes).not.toContain('HISTORY_');
    bytes = '';
    await controller.select('b');
    await pause();
    expect(bytes).toContain('\u001b[3J');
    expect(bytes.split('HISTORY_59_END')).toHaveLength(2);
    expect(bytes.split('CHANGED_COMPLETED_BODY')).toHaveLength(2);
  } finally {
    app.unmount();
    app.cleanup();
    controller.dispose();
    stdin.destroy();
    stdout.destroy();
  }
});

test('Ink preserves message and execution order across the first unsettled row and later history append', async () => {
  let current = snapshot('a', ['EARLY_INCOMPLETE', 'LATER_COMPLETE']);
  current = {
    ...current,
    messages: current.messages.map((message, i) =>
      i === 0 ? { ...message, runId: 'run', status: 'incomplete' } : { ...message, role: 'user' },
    ),
    view: {
      ...current.view,
      runs: [
        {
          id: 'run',
          sessionId: 'a',
          originCommandId: 'original',
          originStoreId: 'store',
          status: 'running',
          isActive: true,
          createdAt: 1,
          finishedAt: null,
          reason: null,
        },
      ],
      executions: [
        {
          id: 'active',
          kind: 'tool',
          definitionId: 'EARLY_ACTIVE_EXEC',
          status: 'running',
          resultRevision: null,
          result: null,
        },
        {
          id: 'done',
          kind: 'tool',
          definitionId: 'LATER_DONE_EXEC',
          status: 'succeeded',
          resultRevision: '1',
          result: null,
        },
      ] as SessionView['executions'],
    },
  };
  const forbidden = async () => {
    throw new Error('display must not submit');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async () => current,
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  });
  await controller.select('a');
  const app = renderFrames(<TuiSession controller={controller} />);
  const ordered = (...markers: string[]) => {
    const frame = app.lastFrame() ?? '';
    const positions = markers.map((marker) => frame.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  };
  try {
    await pause();
    ordered('EARLY_INCOMPLETE', 'LATER_COMPLETE', 'EARLY_ACTIVE_EXEC', 'LATER_DONE_EXEC');
    current = {
      ...current,
      view: { ...current.view, runs: [], executions: current.view.executions.slice(1) },
    };
    await controller.select('a');
    await pause();
    ordered('EARLY_INCOMPLETE', 'LATER_COMPLETE', 'LATER_DONE_EXEC');
    current = {
      ...current,
      messages: [
        ...current.messages,
        { ...current.messages[1]!, id: 'new', seq: '3', content: 'NEW_COMPLETED_AFTER_RESULT' },
      ],
    };
    await controller.select('a');
    await pause();
    ordered('EARLY_INCOMPLETE', 'LATER_COMPLETE', 'NEW_COMPLETED_AFTER_RESULT', 'LATER_DONE_EXEC');
  } finally {
    app.unmount();
    app.cleanup();
    controller.dispose();
  }
});

test('long original question after running Tool keeps material bytes stable on status and answer editing', async () => {
  let current = snapshot('a', ['ROUND_ORIGINAL_MATERIAL']);
  current.view.runs = [
    {
      id: 'run',
      sessionId: 'a',
      originStoreId: 'store',
      originCommandId: 'original',
      status: 'waiting_interaction',
      isActive: true,
      createdAt: 1,
      finishedAt: null,
      reason: null,
    },
  ];
  current.view.executions = [
    {
      id: 'active',
      kind: 'tool',
      definitionId: 'RUNNING_ORIGINAL_TOOL',
      status: 'running',
      resultRevision: '0',
      result: null,
    },
  ] as SessionView['executions'];
  current = {
    ...current,
    interactions: [
      {
        id: 'q',
        originStoreId: 'store',
        sessionId: 'a',
        presentationSessionId: 'a',
        ancestry: ['a'],
        runId: 'run',
        executionId: 'active',
        kind: 'question',
        state: 'pending',
        revision: '1',
        request: {
          schema: {
            type: 'string',
            title: 'ORIGINAL_QUESTION_TITLE',
            description: Array.from({ length: 35 }, (_, i) => `QUESTION_LINE_${i}_END`).join('\n'),
          },
        },
        answer: null,
      },
    ] as unknown as TuiSnapshot['interactions'],
  };
  const forbidden = async () => {
    throw new Error('material update must not submit');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async () => current,
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  });
  await controller.select('a');
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  let bytes = '';
  stdout.on('data', (data) => {
    bytes += data.toString();
  });
  const app = render(<TuiSession controller={controller} />, {
    stdout: stdout as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    stderr: new PassThrough() as unknown as WriteStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await pause();
    expect(bytes.indexOf('ROUND_ORIGINAL_MATERIAL')).toBeLessThan(
      bytes.indexOf('RUNNING_ORIGINAL_TOOL'),
    );
    expect(bytes.indexOf('RUNNING_ORIGINAL_TOOL')).toBeLessThan(
      bytes.indexOf('QUESTION_LINE_34_END'),
    );
    bytes = '';
    controller.openPreferences('language');
    await pause();
    controller.closePanel();
    await pause();
    expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
    expect(bytes).not.toContain('RUNNING_ORIGINAL_TOOL');
    expect(bytes).not.toContain('QUESTION_LINE_');
    expect(bytes).not.toContain('\u001b[3J');
    bytes = '';
    controller.observationUnavailable('bounded-status');
    await pause();
    expect(bytes).not.toContain('\u001b[3J');
    expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
    expect(bytes).not.toContain('RUNNING_ORIGINAL_TOOL');
    expect(bytes).not.toContain('QUESTION_LINE_');
    bytes = '';
    stdin.write('original typed answer');
    await pause();
    expect(bytes).toContain('original typed answer');
    expect(bytes).not.toContain('\u001b[3J');
    expect(bytes).not.toContain('QUESTION_LINE_');
    expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
    bytes = '';
    stdin.write('界'.repeat(700));
    await pause();
    expect(bytes).toContain('Earlier input');
    expect(bytes).not.toContain('QUESTION_LINE_');
    expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
    expect(bytes).not.toContain('\u001b[3J');
    bytes = '';
    current = {
      ...current,
      messages: current.messages.map((message) => ({
        ...message,
        content: 'REPLACED_CURRENT_MESSAGE',
      })),
    };
    await controller.select('a');
    await pause();
    expect(bytes).toContain('\u001b[3J');
    expect(bytes).toContain('REPLACED_CURRENT_MESSAGE');
    expect(bytes).toContain('QUESTION_LINE_34_END');
    expect(bytes).toContain('Earlier input');
    expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
  } finally {
    app.unmount();
    app.cleanup();
    controller.dispose();
    stdin.destroy();
    stdout.destroy();
  }
});
