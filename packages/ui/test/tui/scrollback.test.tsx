import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import type { ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import { Terminal } from '@xterm/headless';
import { Box, render, Text } from 'ink';
import { render as renderFrames } from 'ink-testing-library';
import stringWidth from 'string-width';
import {
  TuiController,
  type TuiPort,
  TuiSession,
  type TuiSnapshot,
  useInkWindowSize,
} from '../../src/tui';

const pause = () => new Promise((resolve) => setTimeout(resolve, 200));

test('finite Plan controls reserve Host rows and retain every choice, description and draft across resize', async () => {
  for (const [diagnostics, chromeRows] of [
    [false, 0],
    [false, 2],
    [true, 3],
  ] as const) {
    const current = snapshot('a', []);
    current.view.runs = [
      {
        id: 'run',
        sessionId: 'a',
        originStoreId: 'store',
        originCommandId: 'work',
        status: 'waiting_interaction',
        isActive: true,
        createdAt: 1,
        finishedAt: null,
        reason: null,
      },
    ];
    current.view.executions = [
      {
        id: 'review',
        originStoreId: 'store',
        sessionId: 'a',
        runId: 'run',
        kind: 'tool',
        definitionId: 'review',
        definitionVersion: '1',
        status: 'dispatching',
        result: null,
        resultRevision: '0',
        cancelRequestedAt: null,
      },
    ];
    Object.assign(current, {
      interactions: [
        {
          id: 'original-plan',
          originStoreId: 'store',
          sessionId: 'a',
          presentationSessionId: 'a',
          runId: 'run',
          executionId: 'review',
          attempt: 1,
          ancestry: ['a'],
          definitionId: 'planning.review',
          definitionVersion: '1',
          inputDigest: 'original-plan-input',
          policyRevision: 'original-plan-policy',
          requiredRefs: [],
          answer: null,
          acceptedDecisionRevision: null,
          kind: 'plan_review',
          state: 'pending',
          revision: '1',
          request: { allowedModes: ['auto', 'accept_edits'] },
        },
      ] as TuiSnapshot['interactions'],
    });
    let writes = 0;
    const forbidden = async () => {
      writes++;
      throw Error('reading and editing never approve');
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
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1000,
      convertEol: true,
      allowProposedApi: true,
    });
    let bytes = '',
      parsed = Promise.resolve();
    stdout.on('data', (chunk) => {
      bytes += chunk.toString();
      parsed = new Promise<void>((resolve) => terminal.write(chunk, resolve));
    });
    const viewport = async () => {
      await parsed;
      return Array.from(
        { length: stdout.rows },
        (_, row) =>
          terminal.buffer.active
            .getLine(terminal.buffer.active.viewportY + row)
            ?.translateToString(true) ?? '',
      )
        .join('\n')
        .replace(/\s+/g, ' ');
    };
    function Host() {
      const { rows } = useInkWindowSize();
      return (
        <Box flexDirection="column" maxHeight={rows - 1} overflowY="hidden">
          {chromeRows > 0 && (
            <Text>
              {Array.from(
                { length: chromeRows },
                (_, index) => `Original Host notice ${index}`,
              ).join('\n')}
            </Text>
          )}
          <TuiSession
            controller={controller}
            testDiagnostics={diagnostics}
            availableRows={rows - 1 - chromeRows}
          />
        </Box>
      );
    }
    const app = render(<Host />, {
      stdout: stdout as unknown as WriteStream,
      stdin: stdin as unknown as ReadStream,
      stderr: new PassThrough() as unknown as WriteStream,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      await pause();
      const first = await viewport();
      for (const text of [
        '1. Start execution in Auto mode',
        'Automatically review non-destructive actions',
        '2. Start execution in Accept edits mode',
        'Edit workspace files without confirming each change',
        '3. Continue planning with feedback',
        'Provide feedback to revise the plan',
        'none (Enter has no answer)',
      ])
        expect(first).toContain(text);
      bytes = '';
      controller.setDraft('original unsent task');
      await pause();
      expect(bytes).not.toContain('\u001b[3J');
      stdin.write('\u001b[B\u001b[B\u001b[B');
      await pause();
      stdin.write('\r');
      await pause();
      stdin.write('literal feedback');
      await pause();
      expect(await viewport()).toContain('literal feedback');
      stdout.columns = 60;
      stdout.rows = 30;
      terminal.resize(60, 30);
      stdout.emit('resize');
      await pause();
      expect(await viewport()).toContain('literal feedback');
      bytes = '';
      controller.setDraft('original unsent task still here');
      await pause();
      expect(bytes).not.toContain('\u001b[3J');
      expect(controller.state.draft).toBe('original unsent task still here');
      expect(writes).toBe(0);
    } finally {
      app.unmount();
      app.cleanup();
      controller.dispose();
      stdin.destroy();
      stdout.destroy();
      terminal.dispose();
    }
  }
});

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
  const ui = renderFrames(<TuiSession testDiagnostics controller={controller} />);
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
    ui.stdin.write('\r');
    ui.stdin.write('\r');
    await pause();
    expect(ui.lastFrame()).not.toContain('TAIL_RESULT_原文🙂');
    expect(ui.lastFrame()).toContain('EARLIER_RESULT_原文🙂');
    expect(writes).toHaveLength(0);
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

test('CtrlO loads original body and reasoning without a CtrlT shortcut or cross-Session leakage', async () => {
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
      if (pending) {
        current.view.runs = [
          {
            id: 'run',
            sessionId: id,
            originStoreId: 'store',
            originCommandId: 'original-work',
            status: 'waiting_interaction',
            isActive: true,
            createdAt: 1,
            finishedAt: null,
            reason: null,
          },
        ];
        current.view.executions.push({
          id: 'question-original',
          originStoreId: 'store',
          sessionId: id,
          runId: 'run',
          kind: 'tool',
          definitionId: 'question',
          definitionVersion: '1',
          status: 'dispatching',
          result: null,
          resultRevision: '0',
          cancelRequestedAt: null,
        });
      }
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
  const ui = renderFrames(<TuiSession testDiagnostics controller={controller} />);
  try {
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).not.toContain('Ctrl+T');
    ui.stdin.write('\u0014');
    await pause();
    expect(reads).toBe(0);
    expect(controller.state.draft).toBe('');
    expect(ui.lastFrame()).toContain('full reader unavailable');
    port.readModelOutput = reader;
    ui.stdin.write('\u000f');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).toContain('FULL_CONTENT_ORIGINAL');
    expect(reads).toBe(1);
    expect(controller.state.loadedOutputBodies.get('message-0')?.reasoning).toBe(reasoning('a'));
    const original = JSON.stringify([...controller.state.loadedOutputBodies]);
    ui.stdin.write('\u0014');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(reads).toBe(1);
    expect(JSON.stringify([...controller.state.loadedOutputBodies])).toBe(original);
    pending = true;
    await controller.select('a');
    await pause();
    expect(ui.lastFrame()).toContain('ORIGINAL_QUESTION');
    ui.stdin.write('\u0014');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(reads).toBe(1);
    expect(JSON.stringify([...controller.state.loadedOutputBodies])).toBe(original);
    pending = false;
    await controller.select('b');
    await pause();
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).not.toContain('REASON_b_');
    expect(controller.state.loadedOutputBodies.size).toBe(0);
    ui.stdin.write('\u000f');
    await pause();
    expect(controller.state.loadedOutputBodies.get('message-0')?.reasoning).toBe(reasoning('b'));
    expect(ui.lastFrame()).not.toContain('REASON_a_');
    expect(ui.lastFrame()).not.toContain('REASON_b_');
    expect(reads).toBe(2);
    await controller.select('c');
    await pause();
    ui.stdin.write('\u000f');
    await pause();
    expect(ui.lastFrame()).toContain('full read unsupported');
    expect(controller.state.loadedOutputBodies.size).toBe(0);
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
  const app = render(<TuiSession testDiagnostics controller={controller} />, {
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

test('late verified giant body replaces its preview in original Static order before the composer', async () => {
  const body = `${'正文'.repeat(1500000)}ACTUAL_HOST_VERIFIED_TAIL`;
  const reasoning = 'ACTUAL_LOADED_REASON_TAIL\n';
  const current = snapshot('a', ['EARLIER_ORIGINAL_MESSAGE', 'ORIGINAL_PREVIEW']);
  const toolResult = `LONG_TOOL_RESULT_${'x'.repeat(620)}_END`;
  current.messages[0]!.toolCalls = [{ id: 'long-call', name: 'original-tool', arguments: '{}' }];
  current.view.executions = [
    {
      id: 'original-tool',
      originStoreId: 'store',
      sessionId: 'a',
      runId: null,
      kind: 'tool',
      definitionId: 'original-tool',
      definitionVersion: '1',
      status: 'succeeded',
      result: { text: toolResult },
      resultRevision: '1',
      cancelRequestedAt: null,
      toolCallId: 'long-call',
      parentExecutionId: null,
    },
  ];
  const message = current.messages[1]!;
  Object.assign(message, {
    runId: 'original-run',
    firstOutput: 'reasoning',
    outputBody: {
      kind: 'model_output',
      executionId: 'original-model',
      complete: true,
      contentBytes: String(Buffer.byteLength(body)),
      reasoningBytes: String(Buffer.byteLength(reasoning)),
      toolCallCount: 0,
    },
  });
  const forbidden = async () => {
    throw Error('late body display must not submit');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'unused',
    listSessions: async () => [],
    readSession: async () => current,
    readModelOutput: async () => {
      const output = { content: body, reasoning, toolCalls: [], complete: true };
      const encoded = Buffer.from(JSON.stringify(output));
      return {
        storeId: 'store',
        sessionId: 'a',
        rootSessionId: 'a',
        runId: 'original-run',
        executionId: 'original-model',
        originCommandId: 'original-work',
        rootWorkCommandId: 'original-work',
        rootWorkSeq: '1',
        attempt: 1,
        status: 'succeeded',
        bodyHash: createHash('sha256').update(encoded).digest('hex'),
        bodyBytes: String(encoded.byteLength),
        contentBytes: String(Buffer.byteLength(body)),
        reasoningBytes: String(Buffer.byteLength(reasoning)),
        snapshotCursor: '1',
        output,
      };
    },
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
  const app = render(<TuiSession testDiagnostics controller={controller} />, {
    stdout: stdout as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    stderr: new PassThrough() as unknown as WriteStream,
    interactive: true,
    incrementalRendering: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await pause();
    expect(bytes).toContain('ORIGINAL_PREVIEW');
    expect(bytes.replace(/\s+/g, '')).toContain(toolResult);
    expect(
      Math.max(
        ...Bun.stripANSI(bytes)
          .split('\n')
          .map((line) => stringWidth(line)),
      ),
    ).toBeLessThanOrEqual(80);
    bytes = '';
    stdout.columns = 60;
    stdout.emit('resize');
    await pause();
    expect(bytes.replace(/\s+/g, '')).toContain(toolResult);
    expect(
      Math.max(
        ...Bun.stripANSI(bytes)
          .split('\n')
          .map((line) => stringWidth(line)),
      ),
    ).toBeLessThanOrEqual(60);
    stdout.columns = 80;
    stdout.emit('resize');
    await pause();
    bytes = '';
    await controller.loadOutput(message);
    await app.waitUntilRenderFlush();
    const emitted = bytes.replace(/\s+/g, '');
    expect(bytes).toContain('\u001b[3J');
    expect(emitted.includes(body)).toBe(true);
    expect(bytes.split('ACTUAL_HOST_VERIFIED_TAIL')).toHaveLength(2);
    expect(bytes.indexOf('EARLIER_ORIGINAL_MESSAGE')).toBeLessThan(bytes.indexOf('正文'));
    expect(bytes.indexOf('LONG_TOOL_RESULT_')).toBeLessThan(bytes.indexOf('正文'));
    expect(bytes.indexOf('ACTUAL_HOST_VERIFIED_TAIL')).toBeLessThan(bytes.lastIndexOf('New Run'));
    bytes = '';
    controller.setDraft('preserved input');
    await pause();
    expect(bytes).toContain('preserved input');
    expect(bytes).not.toContain('ACTUAL_HOST_VERIFIED_TAIL');
    expect(bytes).not.toContain('\u001b[3J');
  } finally {
    app.unmount();
    app.cleanup();
    controller.dispose();
    stdin.destroy();
    stdout.destroy();
  }
}, 30000);

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
  const app = renderFrames(<TuiSession testDiagnostics controller={controller} />);
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

for (const [diagnostics, splitTail] of [
  [true, false],
  [false, true],
] as const)
  test(`long original question after running Tool keeps material bytes stable on status and answer editing (${diagnostics ? 'diagnostic' : 'normal split tail'})`, async () => {
    let current = snapshot('a', ['ROUND_ORIGINAL_MATERIAL']);
    const prefix = `${splitTail ? 'STABLE_ORIGINAL_PREFIX\n\n' : ''}MUTABLE_ORIGINAL_BEGIN ${'原始🙂e\u0301正文'.repeat(1300)} MUTABLE_ORIGINAL_TAIL`;
    current = {
      ...current,
      messages: [
        ...current.messages,
        {
          ...current.messages[0]!,
          id: 'mutable-original',
          seq: '2',
          runId: 'run',
          status: 'incomplete',
          sourceIds: ['original-model'],
          content: prefix,
        },
      ],
    };
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
        id: 'original-model',
        originStoreId: 'store',
        sessionId: 'a',
        runId: 'run',
        kind: 'model',
        definitionId: 'original-model',
        definitionVersion: '1',
        status: 'running',
        resultRevision: '0',
        result: null,
        cancelRequestedAt: null,
      },
      {
        id: 'active',
        originStoreId: 'store',
        sessionId: 'a',
        runId: 'run',
        definitionVersion: '1',
        cancelRequestedAt: null,
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
              description: Array.from({ length: 35 }, (_, i) => `QUESTION_LINE_${i}_END`).join(
                '\n',
              ),
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
    const app = render(<TuiSession testDiagnostics={diagnostics} controller={controller} />, {
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
      // A pending material card promotes even mutable history into Static. The
      // live viewport projection must not crop that original published prefix.
      const plain = bytes
        // biome-ignore lint/suspicious/noControlCharactersInRegex: decode Ink styling, not body characters.
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .normalize()
        .replace(/\s/gu, '');
      expect(plain).toContain(prefix.normalize().replace(/\s/gu, ''));
      expect(plain.split('MUTABLE_ORIGINAL_BEGIN')).toHaveLength(2);
      bytes = '';
      controller.openPreferences('language');
      await pause();
      controller.closePanel();
      await pause();
      expect(bytes).not.toContain('ROUND_ORIGINAL_MATERIAL');
      expect(bytes).not.toContain('RUNNING_ORIGINAL_TOOL');
      expect(bytes).not.toContain('QUESTION_LINE_');
      expect(bytes).not.toContain('MUTABLE_ORIGINAL_');
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
