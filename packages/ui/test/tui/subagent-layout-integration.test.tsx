import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import type { Execution, Message, SessionView } from '@kite-ai/client';
import { render as renderInk } from 'ink';
import { render } from 'ink-testing-library';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';

const execution = (id: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  originStoreId: 'store',
  sessionId: 'parent',
  runId: 'run',
  rootWorkCommandId: 'work',
  rootWorkSeq: '1',
  kind: 'tool',
  definitionId: 'builtin.files/files.read',
  definitionVersion: '1',
  status: 'succeeded',
  result: { content: 'actual result' },
  resultRevision: '1',
  cancelRequestedAt: null,
  parentExecutionId: null,
  childSessionId: null,
  ...extra,
});
const view = (id: string, executions: Execution[]): SessionView => ({
  storeId: 'store',
  snapshotCursor: '1',
  session: {
    id,
    workspaceId: 'w',
    parentSessionId: id === 'parent' ? null : 'parent',
    rootSessionId: 'parent',
    title: id,
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '2',
    deletedAt: null,
  },
  messages: [],
  executions,
  runs: [
    {
      id: 'run',
      sessionId: 'parent',
      originStoreId: 'store',
      originCommandId: 'work',
      status: 'running',
      isActive: true,
      createdAt: 1,
      finishedAt: null,
      reason: null,
      configuration: {},
    },
  ],
});

test('ordinary main screen compresses actual concurrent child cards in a short terminal and keeps their current summary visible', async () => {
  const calls = Array.from({ length: 4 }, (_, i) => ({
    id: `call-${i}`,
    name: 'task',
    arguments: JSON.stringify({ role: 'explore', input: `child-${i}` }),
  }));
  const model = execution('model', {
    kind: 'model',
    definitionId: 'model',
    result: { content: '', reasoning: '', toolCalls: calls },
  });
  const parents = calls.map((call, i) =>
    execution(`task-${i}`, {
      definitionId: 'builtin.task/task',
      parentExecutionId: 'model',
      toolCallId: call.id,
      toolInput: { role: 'explore', input: `child-${i}` },
      status: 'running',
      result: null,
    }),
  );
  const carriers = parents.map((parent, i) =>
    execution(`carrier-${i}`, {
      kind: 'job',
      runId: null,
      definitionId: 'agent/explore',
      parentExecutionId: parent.id,
      childSessionId: `child-${i}`,
      status: 'running',
      result: null,
    }),
  );
  const message: Message = {
    id: 'launch',
    seq: '1',
    sessionId: 'parent',
    runId: 'run',
    role: 'assistant',
    status: 'complete',
    content: '',
    sourceIds: ['model'],
    toolCalls: calls,
  };
  const snapshot: TuiSnapshot = {
    storeId: 'store',
    view: view('parent', [model, ...parents, ...carriers]),
    messages: [message],
    interactions: [],
    executionTimings: Object.fromEntries(
      carriers.map((carrier) => [
        carrier.id,
        { availability: 'recorded_dispatch', startedAt: Date.now() - 100 },
      ]),
    ),
    childViews: carriers.map((carrier, i) => ({
      executionId: carrier.id,
      view: view(
        `child-${i}`,
        Array.from({ length: 8 }, (_, at) =>
          execution(`step-${i}-${at}`, {
            sessionId: `child-${i}`,
            toolInput: { path: `STEP_${i}_${at}.ts` },
          }),
        ),
      ),
    })),
  };
  const before = JSON.stringify(snapshot);
  let reads = 0,
    mutations = 0;
  const forbidden = async () => {
    mutations++;
    throw Error('layout must not dispatch');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'never',
    listSessions: async () => [],
    readSession: async () => {
      reads++;
      return snapshot;
    },
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const controller = new TuiController(port);
  await controller.select('parent');
  const app = render(<TuiSession controller={controller} />);
  try {
    Object.defineProperty(app.stdout, 'rows', { configurable: true, get: () => 14 });
    app.stdout.emit('resize');
    await Bun.sleep(40);
    const frame = app.lastFrame()!;
    expect(frame).toContain('Delegating · 4 agents');
    expect(frame).toContain('agents folded');
    expect(frame).toContain('child-3');
    expect(frame).not.toContain('STEP_0_0.ts');
    expect(frame).not.toContain('"rootWorkCommandId"');
    expect(reads).toBe(1);
    expect(mutations).toBe(0);
    expect(JSON.stringify(snapshot)).toBe(before);
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('an unavailable optional model selection does not clear native history while its exact recorded Model is unchanged', async () => {
  let snapshot: TuiSnapshot = {
    storeId: 'store',
    view: view('parent', []),
    interactions: [],
    messages: [
      {
        id: 'history',
        seq: '1',
        sessionId: 'parent',
        runId: 'run',
        role: 'assistant',
        status: 'complete',
        content: Array.from({ length: 40 }, (_, i) => `HISTORY_${i}`).join('\n\n'),
      },
    ],
    environment: {
      workspacePath: '/owned',
      modelId: 'config-id',
      modelName: 'original-model',
      runtimeModel: {
        runId: 'run',
        active: false,
        modelName: 'original-model',
        source: 'model_input',
      },
    },
  };
  snapshot.view.runs[0] = { ...snapshot.view.runs[0]!, isActive: false, status: 'completed' };
  const forbidden = async () => {
    throw Error('display does not execute');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'never',
    listSessions: async () => [],
    readSession: async () => snapshot,
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  });
  await controller.select('parent');
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  let bytes = '';
  stdout.on('data', (chunk) => {
    bytes += chunk.toString();
  });
  const app = renderInk(<TuiSession controller={controller} />, {
    stdout: stdout as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    stderr: new PassThrough() as unknown as WriteStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await Bun.sleep(100);
    expect(bytes).toContain('HISTORY_39');
    bytes = '';
    snapshot = {
      ...snapshot,
      environment: { workspacePath: '/owned', runtimeModel: snapshot.environment!.runtimeModel },
    };
    await controller.select('parent');
    await Bun.sleep(100);
    expect(bytes).not.toContain('\u001b[3J');
    expect(bytes).not.toContain('HISTORY_');
  } finally {
    app.unmount();
    controller.dispose();
    stdin.destroy();
    stdout.destroy();
  }
});
