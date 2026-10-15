import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  Execution,
  Interaction,
  Message,
  ModelOutputSnapshot,
  SessionView,
} from '@kite-ai/client';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { TuiController, type TuiPort, TuiSession, type TuiSnapshot } from '../../src/tui';
import type { TuiMcpReadDirectory, TuiMcpSnapshot } from '../../src/tui/mcp';

const tick = () => Bun.sleep(40);
const view = (executions: Execution[] = []): SessionView => ({
  storeId: 'store',
  snapshotCursor: '1',
  session: {
    id: 's',
    workspaceId: 'w',
    parentSessionId: null,
    rootSessionId: 's',
    title: 'original',
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '2',
    deletedAt: null,
  },
  messages: [],
  executions,
  runs: [],
});
const forbidden = async () => {
  throw Error('display must not execute');
};
const port = (read: () => TuiSnapshot, extra: Partial<TuiPort> = {}): TuiPort => ({
  storeId: 'store',
  nextCommandId: () => 'original',
  listSessions: async () => [],
  readSession: async () => read(),
  submit: forbidden,
  answer: forbidden,
  cancel: forbidden,
  getCommand: forbidden,
  ...extra,
});
const model: Execution = {
  id: 'model',
  originStoreId: 'store',
  sessionId: 's',
  runId: 'run',
  kind: 'model',
  definitionId: 'model',
  definitionVersion: '1',
  status: 'succeeded',
  result: null,
  resultRevision: '1',
  cancelRequestedAt: null,
  parentExecutionId: null,
  childSessionId: null,
};

function output(body: ModelOutputSnapshot['output']): ModelOutputSnapshot {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    storeId: 'store',
    sessionId: 's',
    rootSessionId: 's',
    runId: 'run',
    executionId: 'model',
    originCommandId: 'work',
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
    attempt: 1,
    status: body.complete ? 'succeeded' : 'running',
    snapshotCursor: '1',
    bodyHash: createHash('sha256').update(bytes).digest('hex'),
    bodyBytes: String(bytes.byteLength),
    contentBytes: String(Buffer.byteLength(body.content)),
    reasoningBytes: String(Buffer.byteLength(body.reasoning)),
    output: body,
  };
}

test('normal recorded and streamed Markdown keep every wrapped reply row inside its indented column', async () => {
  const plain =
    '首段开始：如果是明确的实施类任务，我会直接交付实现、必要验证和受影响文档的同步说明，不额外建计划；只有会实质改变产品行为、范围或授权边界且现有证据无法裁决的问题，我才会请你决定。首段结束';
  const styled =
    '次段开始：**完整中文说明** 与 `original-code` 保持原文，混排 café é 🧭，以及 [原链接](https://example.test/original) 和足够长的后续中文说明，用来核对所有换行后的文本仍与首行对齐。次段结束';
  const content = `${plain}\n\n${styled}`;
  const expected = `${plain}次段开始：完整中文说明 与 original-code 保持原文，混排 café é 🧭，以及 原链接 (https://example.test/original) 和足够长的后续中文说明，用来核对所有换行后的文本仍与首行对齐。次段结束`;
  for (const streaming of [false, true]) {
    const body = output({ content, reasoning: '', toolCalls: [], complete: !streaming });
    const snapshot: TuiSnapshot = {
      storeId: 'store',
      view: view([{ ...model, status: streaming ? 'running' : 'succeeded' }]),
      ...(streaming ? { liveModelOutput: body } : {}),
      interactions: [],
      messages: [
        {
          id: 'aligned-answer',
          seq: '1',
          sessionId: 's',
          runId: 'run',
          role: 'assistant',
          status: streaming ? 'incomplete' : 'complete',
          sourceIds: ['model'],
          content,
        },
      ],
    };
    const original = JSON.stringify(snapshot);
    const controller = new TuiController(port(() => snapshot));
    await controller.select('s');
    const app = render(<TuiSession controller={controller} />);
    Object.defineProperty(app.stdout, 'columns', { value: 40, configurable: true });
    app.stdout.emit('resize');
    try {
      await tick();
      const frame = app.lastFrame()!.split('\n');
      const start = frame.findIndex((line) => line.includes('首段开始'));
      const end = frame.findIndex((line) => line.includes('次段结束'));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const rows = frame.slice(start, end + 1).filter((line) => line.trim());
      expect(rows.length).toBeGreaterThan(4);
      for (const line of rows) {
        expect(line.startsWith('  ')).toBe(true);
        expect(stringWidth(line)).toBeLessThanOrEqual(40);
      }
      expect(
        rows
          .map((line) => line.slice(2))
          .join('')
          .normalize()
          .replace(/\s/gu, ''),
      ).toBe(expected.normalize().replace(/\s/gu, ''));
      expect(JSON.stringify(snapshot)).toBe(original);
    } finally {
      app.unmount();
      app.cleanup();
      controller.dispose();
    }
  }
});

test('normal main screen automatically reads one complete original body and retains literal user Markdown', async () => {
  const body = output({
    content:
      '# Original complete answer\n\n| Name | Value |\n|---|---|\n| 原文 | preserved |\n\n```ts\nconst actual = 1;\n```\n\nCOMPLETE_TAIL',
    reasoning: 'saved thinking',
    toolCalls: [],
    complete: true,
  });
  const message: Message = {
    id: 'answer',
    seq: '2',
    sessionId: 's',
    runId: 'run',
    role: 'assistant',
    status: 'complete',
    content: 'preview',
    firstOutput: 'reasoning',
    sourceIds: ['model'],
    outputBody: {
      kind: 'model_output',
      executionId: 'model',
      complete: true,
      contentBytes: body.contentBytes,
      reasoningBytes: body.reasoningBytes,
      toolCallCount: 0,
    },
  };
  const snapshot: TuiSnapshot = {
    storeId: 'store',
    view: view([model]),
    executionTimings: {
      model: { availability: 'recorded_dispatch', startedAt: 1, finishedAt: 2001 },
    },
    interactions: [],
    messages: [
      {
        id: 'user',
        seq: '1',
        sessionId: 's',
        runId: 'run',
        role: 'user',
        status: 'complete',
        content: '**literal user**',
      },
      message,
    ],
  };
  let reads = 0;
  const controller = new TuiController(
    port(() => snapshot, {
      readModelOutput: async (session, execution) => {
        reads++;
        expect([session, execution]).toEqual(['s', 'model']);
        return body;
      },
    }),
  );
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('❯ **literal user**');
    expect(app.lastFrame()).toContain('COMPLETE_TAIL');
    expect(app.lastFrame()).toContain('const actual = 1;');
    expect(app.lastFrame()).toContain('preserved');
    expect(app.lastFrame()).not.toContain('preview only');
    expect(app.lastFrame()).toContain('Thinking 2s');
    const lines = app.lastFrame()!.split('\n');
    const thought = lines.find((line) => line.includes('Thinking 2s'));
    const reply = lines.find((line) => line.includes('Original complete answer'));
    expect(thought).toBe('  Thinking 2s');
    expect(reply?.indexOf('Original complete answer')).toBe(thought!.indexOf('Thinking'));
    controller.setDraft('editing without output replay');
    await tick();
    await controller.select('s');
    await tick();
    expect(reads).toBe(1);
    expect(controller.state.loadedOutputBodies.get('answer')).toEqual(body.output);
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('live small reasoning uses the actual running Model before a terminal result and remains mutable', async () => {
  const live = output({
    content: 'streamed answer',
    reasoning: 'actual small thinking line',
    toolCalls: [],
    complete: false,
  });
  let snapshot: TuiSnapshot = {
    storeId: 'store',
    view: view([{ ...model, status: 'running', result: null }]),
    interactions: [],
    liveModelOutput: live,
    messages: [
      {
        id: 'prefix',
        seq: '1',
        sessionId: 's',
        runId: 'run',
        role: 'assistant',
        status: 'incomplete',
        content: 'old preview',
        sourceIds: ['model'],
      },
    ],
  };
  const controller = new TuiController(port(() => snapshot));
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await tick();
    expect(app.lastFrame()).toContain('actual small thinking line');
    expect(
      app
        .lastFrame()!
        .split('\n')
        .find((line) => line.includes('Thinking'))
        ?.indexOf('Thinking'),
    ).toBe(2);
    // The reason-first response keeps answer bytes buffered until classified.
    expect(app.lastFrame()).not.toContain('streamed answer');
    expect(app.lastFrame()).not.toContain('Incomplete response');
    snapshot = {
      ...snapshot,
      liveModelOutput: output({ ...live.output, reasoning: 'actual updated thinking line' }),
    };
    await controller.select('s');
    await tick();
    expect(app.lastFrame()).toContain('actual updated thinking line');
    expect(app.lastFrame()).not.toContain('actual small thinking line');
    snapshot = {
      ...snapshot,
      liveModelOutput: undefined,
      view: view([
        {
          ...model,
          status: 'succeeded',
          result: {
            content: 'streamed answer',
            reasoning: 'actual updated thinking line',
            toolCalls: [],
          },
        },
      ]),
      messages: [
        {
          ...snapshot.messages[0]!,
          status: 'complete',
          firstOutput: 'reasoning',
          content: 'streamed answer',
        },
      ],
    };
    await controller.select('s');
    await tick();
    expect(app.lastFrame()).toContain('streamed answer');
    expect(app.lastFrame()).not.toContain('actual updated thinking line');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('prompt registry selection rechecks its actual retained source and only creates the original local display', async () => {
  const facts = {
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    labels: { server: 'ActualName' },
    items: [
      {
        id: 'server',
        configDigest: 'a'.repeat(64),
        admitted: true,
        selected: true,
        available: true,
      },
    ],
  } as unknown as TuiMcpSnapshot;
  const page: TuiMcpReadDirectory = {
    family: 'prompts',
    sessionId: 's',
    workspaceId: 'w',
    nextAfterKey: null,
    items: [
      {
        key: 'prompts/001',
        serverId: 'server',
        configDigest: 'a'.repeat(64),
        generation: 1,
        live: true,
        descriptors: [{ name: 'original', description: 'actual retained description' }],
        descriptorDigests: ['b'.repeat(64)],
      },
    ],
  };
  const snapshot: TuiSnapshot = { storeId: 'store', view: view(), messages: [], interactions: [] };
  let reads = 0;
  const controller = new TuiController(
    port(() => snapshot, {
      mcp: {
        read: async () => facts,
        readDirectory: async () => {
          reads++;
          return page;
        },
        submit: forbidden,
        lookup: forbidden,
      },
    }),
  );
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await tick();
    controller.setDraft('/mcp__');
    await tick();
    expect(app.lastFrame()).toContain('/mcp__ActualName__original');
    expect(app.lastFrame()).toContain('actual retained description');
    await controller.routeCommand('/mcp__ActualName__original');
    await tick();
    expect(reads).toBe(2);
    expect(app.lastFrame()).toContain('❯ /mcp__ActualName__original');
    expect(controller.state.snapshot?.view.runs).toHaveLength(0);
    expect(controller.state.intent).toBeUndefined();
    facts.items[0]!.available = false;
    await controller.routeCommand('/mcp__ActualName__original');
    await tick();
    expect(controller.state.mcpPromptSelections).toHaveLength(1);
    expect(controller.state.error).toBe('mcp_prompt_unavailable');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('first question Escape cancels the exact presented original execution once', async () => {
  const card: Interaction = {
    id: 'question',
    originStoreId: 'store',
    sessionId: 'child',
    presentationSessionId: 's',
    runId: 'child-run',
    executionId: 'original-question-tool',
    attempt: 1,
    ancestry: ['s', 'child'],
    kind: 'question',
    definitionId: 'ask_user',
    definitionVersion: '1',
    inputDigest: 'hash',
    policyRevision: '1',
    requiredRefs: [],
    request: { schema: { type: 'string', title: 'Original child question' } },
    answer: null,
    revision: '1',
    acceptedDecisionRevision: null,
    state: 'pending',
  };
  const snapshot: TuiSnapshot = {
    storeId: 'store',
    view: view(),
    messages: [],
    interactions: [card],
  };
  const requests: unknown[] = [];
  const controller = new TuiController(
    port(() => snapshot, {
      executions: {
        getExecution: forbidden,
        output: forbidden,
        getView: forbidden,
        getRun: forbidden,
        messages: forbidden,
        modelOutput: forbidden,
        getCommand: forbidden,
        stop: async (session, request) => {
          requests.push({ session, request });
          return {
            id: request.commandId,
            sessionId: session,
            originStoreId: 'store',
            kind: 'execution.cancel',
            status: 'applied',
            cancelRequestedAt: null,
            receipt: {
              outcome: 'cancel_requested',
              executionId: request.executionId,
              affectedCount: 1,
            },
          };
        },
      },
    }),
  );
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await tick();
    app.stdin.write('\u001b');
    await tick();
    app.stdin.write('\u001b');
    await tick();
    expect(requests).toEqual([
      {
        session: 'child',
        request: {
          kind: 'execution.cancel',
          expectedStoreId: 'store',
          commandId: 'original',
          executionId: 'original-question-tool',
        },
      },
    ]);
    expect(controller.state.intent?.phase).toBe('applied');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('a completed Model retains its original delegation caption before its qualified child result', async () => {
  const call = {
    id: 'call-child',
    name: 'task.execute',
    arguments: JSON.stringify({
      role: 'agent/explore',
      key: 'child',
      input: { name: 'Child task', content: 'Inspect only' },
    }),
  };
  const originalModel: Execution = {
    ...model,
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
    result: {
      content: 'ORIGINAL_DELEGATION_CAPTION',
      reasoning: 'Original private reasoning',
      toolCalls: [call],
    },
  };
  const task: Execution = {
    ...originalModel,
    id: 'task',
    kind: 'tool',
    definitionId: 'builtin.task/task.execute',
    parentExecutionId: 'model',
    toolCallId: call.id,
    toolInput: JSON.parse(call.arguments),
    result: { content: 'Child started' },
  };
  const child: Execution = {
    ...task,
    id: 'carrier',
    kind: 'job',
    definitionId: 'agent/explore',
    runId: null,
    parentExecutionId: task.id,
    childSessionId: 'child',
    result: { content: 'Child complete' },
  };
  const parentView = view([originalModel, task, child]);
  parentView.runs = [
    {
      id: 'run',
      originStoreId: 'store',
      sessionId: 's',
      originCommandId: 'work',
      status: 'completed',
      isActive: false,
      createdAt: 1,
      finishedAt: 2,
      reason: null,
    },
  ];
  const childView = view();
  childView.session = {
    ...childView.session,
    id: 'child',
    parentSessionId: 's',
    rootSessionId: 's',
  };
  const snapshot: TuiSnapshot = {
    storeId: 'store',
    view: parentView,
    interactions: [],
    messages: [
      {
        id: 'caption',
        seq: '1',
        sessionId: 's',
        runId: 'run',
        role: 'assistant',
        status: 'complete',
        firstOutput: 'reasoning',
        content: 'ORIGINAL_DELEGATION_CAPTION',
        sourceIds: ['model'],
        toolCalls: [call],
      },
    ],
    childViews: [{ executionId: child.id, view: childView }],
    executionTimings: {
      model: { availability: 'recorded_dispatch', startedAt: 1, finishedAt: 1001 },
    },
  };
  const controller = new TuiController(port(() => snapshot));
  await controller.select('s');
  const app = render(<TuiSession controller={controller} />);
  try {
    await tick();
    const rendered = app.lastFrame()!;
    expect(rendered.split('ORIGINAL_DELEGATION_CAPTION')).toHaveLength(2);
    expect(rendered.indexOf('Thinking')).toBeLessThan(
      rendered.indexOf('ORIGINAL_DELEGATION_CAPTION'),
    );
    expect(rendered).not.toContain('Original private reasoning');
    expect(rendered).toContain('Child task');
    expect(controller.state.intent).toBeUndefined();
  } finally {
    app.unmount();
    controller.dispose();
  }
});
