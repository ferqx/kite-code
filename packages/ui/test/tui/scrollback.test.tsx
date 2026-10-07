import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import type { ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import { render } from 'ink';
import { render as renderFrames } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));

test('empty Enter toggles only the original tail result; input, refresh and earlier results keep their original facts', async () => {
  const current = snapshot('a', ['MODEL_HISTORY_ORIGINAL']);
  current.view.executions = ['earlier', 'tail'].map((id) => ({
    id,
    originStoreId: 'store',
    sessionId: 'a',
    runId: null,
    kind: id === 'tail' ? 'job' : 'tool',
    definitionId: `original-${id}`,
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
    result: { text: `${id.toUpperCase()}_RESULT_原文🙂`, path: '/Original/Language' },
    cancelRequestedAt: null,
    parentExecutionId: null,
    childSessionId: id === 'tail' ? 'original-child' : null,
  }));
  const before = JSON.stringify(current);
  const writes: unknown[] = [];
  let reads = 0;
  const forbidden = async () => {
    throw Error('display must not answer, cancel or query a Command');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'typed-original',
    listSessions: async () => [],
    readSession: async () => {
      reads++;
      return current;
    },
    submit: async (id, request) => {
      writes.push({ id, request });
      return {
        id: request.commandId,
        sessionId: id,
        kind: request.kind,
        originStoreId: 'store',
        status: 'accepted',
        receipt: {},
        cancelRequestedAt: null,
      };
    },
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  });
  await controller.select('a');
  const ui = renderFrames(<TuiSession controller={controller} />);
  try {
    await pause();
    expect(ui.lastFrame()).toContain('TAIL_RESULT_原文🙂');
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    expect(ui.lastFrame()).toContain('original-tail [tail] succeeded');
    expect(ui.lastFrame()).toContain('EARLIER_RESULT_原文🙂');
    expect(ui.lastFrame()).toContain('MODEL_HISTORY_ORIGINAL');
    expect(writes).toHaveLength(0);
    expect(reads).toBe(1);
    controller.setDraft('typed queued 原文🙂');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    ui.stdin.write('\r');
    await pause();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: 'a', request: { content: 'typed queued 原文🙂' } });
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    controller.setDraft('');
    await controller.select('a');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).toContain('TAIL_RESULT_原文🙂');
    expect(JSON.stringify(current)).toBe(before);
    expect(writes).toHaveLength(1);
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    controller.clearDisplay();
    await pause();
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    expect(writes).toHaveLength(1);
    current.view.executions = current.view.executions.map((item) =>
      item.id === 'tail'
        ? { ...item, resultRevision: '2', result: { text: 'TAIL_RESULT_UPDATED_原文🙂' } }
        : item,
    );
    await controller.select('a');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_UPDATED_原文🙂');
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).toContain('TAIL_RESULT_UPDATED_原文🙂');
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_UPDATED_原文🙂');
    expect(writes).toHaveLength(1);
  } finally {
    ui.unmount();
    ui.cleanup();
    controller.dispose();
  }
});

test('CtrlT reads original reasoning once, toggles only display and never carries it to another Session', async () => {
  let reads = 0;
  let pending = false;
  const reasoning = (id: string) => `REASON_${id}_原文🙂 /Theme/Language\u001b[2J`;
  const forbidden = async () => {
    throw Error('reasoning display must not execute');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'never',
    listSessions: async () => [],
    readSession: async (id) => {
      const current = snapshot(id, ['PREVIEW_ORIGINAL']);
      const messages: TuiSnapshot['messages'] = current.messages.map((m) => ({
        ...m,
        runId: 'run',
        outputBody: {
          kind: 'model_output',
          executionId: 'model-original',
          complete: true,
          contentBytes: '21',
          reasoningBytes: String(Buffer.byteLength(reasoning(id))),
          toolCallCount: 0,
          ...(id === 'c' ? { readAvailability: 'unsupported' as const } : {}),
        },
      }));
      const interactions: TuiSnapshot['interactions'] = pending
        ? [
            {
              id: 'original-question',
              originStoreId: 'store',
              sessionId: id,
              presentationSessionId: id,
              runId: 'run',
              executionId: 'question-original',
              attempt: 1,
              ancestry: [],
              definitionId: 'question',
              definitionVersion: '1',
              inputDigest: 'original-input',
              policyRevision: '1',
              requiredRefs: [],
              answer: null,
              acceptedDecisionRevision: null,
              kind: 'question',
              revision: '1',
              state: 'pending',
              request: { schema: { type: 'string', title: 'ORIGINAL_QUESTION', minLength: 1 } },
            },
          ]
        : [];
      return { ...current, messages, interactions };
    },
    readModelOutput: async (id, executionId) => {
      reads++;
      const output: ModelOutputSnapshot['output'] = {
        content: 'FULL_CONTENT_ORIGINAL',
        reasoning: reasoning(id),
        toolCalls: [],
        complete: true,
      };
      const body = Buffer.from(JSON.stringify(output));
      return {
        storeId: 'store',
        sessionId: id,
        rootSessionId: id,
        runId: 'run',
        executionId,
        originCommandId: 'original-work',
        rootWorkCommandId: 'original-work',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: createHash('sha256').update(body).digest('hex'),
        bodyBytes: String(body.byteLength),
        contentBytes: String(Buffer.byteLength(output.content)),
        reasoningBytes: String(Buffer.byteLength(output.reasoning)),
        snapshotCursor: '1',
        output,
      };
    },
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const reader = port.readModelOutput;
  port.readModelOutput = undefined;
  const controller = new TuiController(port);
  await controller.select('a');
  const ui = renderFrames(<TuiSession controller={controller} />);
  try {
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('Recorded reasoning not loaded; full reader unavailable');
    expect(reads).toBe(0);
    ui.stdin.write('\u0014');
    await pause();
    port.readModelOutput = reader;
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('REASON_a_原文🙂 /Theme/Language\\u001b[2J');
    expect(ui.lastFrame()).toContain('FULL_CONTENT_ORIGINAL');
    expect(reads).toBe(1);
    const original = JSON.stringify([...controller.state.loadedOutputBodies]);
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).toContain('FULL_CONTENT_ORIGINAL');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('REASON_a_');
    expect(reads).toBe(1);
    expect(JSON.stringify([...controller.state.loadedOutputBodies])).toBe(original);
    pending = true;
    await controller.select('a');
    await pause();
    expect(ui.lastFrame()).toContain('ORIGINAL_QUESTION');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('REASON_a_');
    expect(reads).toBe(1);
    pending = false;
    await controller.select('b');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).not.toContain('REASON_b_');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('REASON_b_');
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(reads).toBe(2);
    await controller.select('c');
    await pause();
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).toContain('Recorded reasoning not loaded; full read unsupported');
    expect(reads).toBe(2);
  } finally {
    ui.unmount();
    ui.cleanup();
    controller.dispose();
  }
});
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
