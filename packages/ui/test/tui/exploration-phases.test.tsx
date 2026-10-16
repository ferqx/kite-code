import { expect, test } from 'bun:test';
import type { Execution, Message } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiSession } from '../../src/tui';
import { TuiController, type TuiPort, type TuiSnapshot } from '../../src/tui/controller';
import { projectInkExplorationPhases } from '../../src/tui/exploration-phases';
import ToolSummaryBlock from '../../src/tui/ink/ToolSummaryBlock';
import { buildToolSummaryLine } from '../../src/tui/ink/tool-summary-line';
import {
  advanceInkModelStream,
  inkModelStreamVisibility,
  observedModelRetry,
  settleInkModelStream,
} from '../../src/tui/model-stream-presentation';

const execution = (id: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  originStoreId: 'store',
  sessionId: 'session',
  runId: 'run',
  rootWorkCommandId: 'work',
  rootWorkSeq: '1',
  kind: 'tool',
  definitionId: 'files.read',
  definitionVersion: '1',
  status: 'succeeded',
  result: { content: 'source' },
  resultRevision: '1',
  cancelRequestedAt: null,
  parentExecutionId: null,
  childSessionId: null,
  ...extra,
});
function fixture(batches: string[][]): TuiSnapshot {
  const messages: Message[] = batches.map((calls, index) => ({
    id: `message-${index}`,
    seq: String(index + 1),
    sessionId: 'session',
    runId: 'run',
    role: 'assistant',
    status: 'complete',
    content: calls.length ? `narration-${index}` : 'ANSWER',
    sourceIds: [`model-${index}`],
    toolCalls: calls.map((id) => ({ id, name: id, arguments: '{"path":"original.ts"}' })),
  }));
  const executions = batches.flatMap((calls, index) => [
    execution(`model-${index}`, { kind: 'model', definitionId: 'model', result: null }),
    ...calls.map((id) => execution(id, { toolCallId: id, toolInput: { path: 'original.ts' } })),
  ]);
  return {
    storeId: 'store',
    messages,
    interactions: [],
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id: 'session',
        workspaceId: 'w',
        parentSessionId: null,
        rootSessionId: 'session',
        title: 'fixture',
        controlRevision: '1',
        contextSelectionId: 'selection',
        nextSeq: '20',
        deletedAt: null,
      },
      messages,
      executions,
      runs: [
        {
          id: 'run',
          originStoreId: 'store',
          sessionId: 'session',
          originCommandId: 'command',
          status: 'completed',
          isActive: false,
          createdAt: 0,
          finishedAt: 5,
          reason: null,
          configuration: {
            snapshot: {
              planning: {
                binding: {
                  tools: [
                    {
                      extensionId: 'builtin.files',
                      definitionId: 'files.read',
                      definitionVersion: '1',
                    },
                  ],
                  readOnlyDefinitions: [
                    { kind: 'tool', definitionId: 'files.read', definitionVersion: '1' },
                  ],
                },
              },
            },
          },
        },
      ],
    },
  } as TuiSnapshot;
}
test('single reads and consecutive original Model calls share one exploration owner and answer label', () => {
  const source = fixture([['read-one'], ['read-two'], []]);
  const bodies = new Map(
    source.messages.map((message) => [
      message.id,
      {
        content: message.content,
        reasoning: 'PRIVATE REASONING',
        toolCalls: message.toolCalls ?? [],
        complete: true,
      },
    ]),
  );
  const projection = projectInkExplorationPhases(source, bodies);
  expect(projection.phases).toHaveLength(1);
  expect(projection.phases[0]).toMatchObject({
    messageId: 'message-0',
    messageIds: ['message-0', 'message-1', 'message-2'],
    executionIds: ['read-one', 'read-two'],
    block: { summaryLine: 'read 2 files', hasThinking: true, active: false },
  });
  expect([...projection.suppressedNarrationMessageIds]).toEqual(['message-0', 'message-1']);
  expect([...projection.thoughtConsumedMessageIds]).toEqual([
    'message-0',
    'message-1',
    'message-2',
  ]);
  expect(projection.phases[0]!.block.totalElapsedMs).toBeUndefined();
  const app = render(<ToolSummaryBlock block={projection.phases[0]!.block} columns={80} />);
  try {
    expect(app.lastFrame()).toContain('Thinking');
    expect(app.lastFrame()).toContain('read 2 files');
    expect(app.lastFrame()).not.toContain('PRIVATE');
    expect(app.lastFrame()).not.toContain('original.ts');
  } finally {
    app.unmount();
  }
});
test('non-exploration boundary splits tools in source order and consumes reasoning exactly once', () => {
  const source = fixture([['before', 'write', 'after-one', 'after-two'], []]);
  source.view.executions.find((item) => item.id === 'write')!.definitionId =
    'builtin.files/files.write';
  const bodies = new Map([
    [
      'message-0',
      {
        content: 'caption',
        reasoning: 'private',
        toolCalls: source.messages[0]!.toolCalls!,
        complete: true,
      },
    ],
  ]);
  const projection = projectInkExplorationPhases(source, bodies);
  expect(projection.phases).toHaveLength(2);
  expect(projection.phases.map((phase) => [phase.executionIds, phase.block.hasThinking])).toEqual([
    [['before'], true],
    [['after-one', 'after-two'], false],
  ]);
  expect(projection.phases.flatMap((phase) => phase.executionIds)).not.toContain('write');
});
test('original scope and unique call/source proof reject foreign or ambiguous eligibility', () => {
  const source = fixture([['read'], []]);
  source.view.executions.find((item) => item.id === 'read')!.originStoreId = 'foreign';
  expect(projectInkExplorationPhases(source).phases).toEqual([]);
  source.view.executions.find((item) => item.id === 'read')!.originStoreId = 'store';
  (source.messages as Message[]).push({ ...source.messages[0]!, id: 'duplicate', seq: '3' });
  expect(projectInkExplorationPhases(source).phases).toEqual([]);
});
test('Shell exploration requires exact effect proof and consumes its actual carrier once', () => {
  const source = fixture([['shell'], []]);
  const tool = source.view.executions.find((item) => item.id === 'shell')!;
  Object.assign(tool, {
    definitionId: 'builtin.shell/shell.launch',
    toolInput: { command: 'read command' },
  });
  source.view.executions.push(
    execution('carrier', {
      kind: 'job',
      runId: null,
      definitionId: 'shell.command',
      parentExecutionId: 'shell',
    }),
  );
  expect(projectInkExplorationPhases(source).phases).toEqual([]);
  const fact = {
    originStoreId: 'store',
    sessionId: 'session',
    runId: 'run',
    executionId: 'shell',
    definitionId: tool.definitionId,
    definitionVersion: '1',
    presentation: 'exploration' as const,
  };
  const projection = projectInkExplorationPhases(source, new Map(), [fact]);
  expect(projection.phases[0]).toMatchObject({
    executionIds: ['shell', 'carrier'],
    block: { summaryLine: 'ran 1 shell command' },
  });
  expect(
    projectInkExplorationPhases(source, new Map(), [{ ...fact, runId: 'foreign' }]).phases,
  ).toEqual([]);
});
test('saved builtin Shell presentation joins adjacent reads only with its exact carrier receipt', () => {
  const source = fixture([['read', 'shell'], []]);
  const tool = source.view.executions.find((item) => item.id === 'shell')!;
  Object.assign(tool, {
    definitionId: 'builtin.shell/shell.execute',
    toolInput: { command: 'not parsed by the UI' },
    result: {
      outcome: 'succeeded',
      details: {
        presentation: 'exploration',
        ref: {
          executionId: 'carrier',
          originStoreId: 'store',
          sessionId: 'session',
          extensionId: 'builtin.shell',
          commandId: 'original-command',
          key: 'original-key',
        },
      },
    },
  });
  const carrier = execution('carrier', {
    kind: 'job',
    runId: null,
    definitionId: 'shell.command',
    parentExecutionId: tool.id,
  });
  source.view.executions.push(carrier);
  expect(projectInkExplorationPhases(source).phases).toHaveLength(1);
  expect(projectInkExplorationPhases(source).phases[0]?.block.summaryLine).toBe(
    'read 1 file, ran 1 shell command',
  );
  const details = (
    tool.result as { details: { presentation: string; ref: { executionId: string } } }
  ).details;
  details.ref.executionId = 'replacement';
  expect(projectInkExplorationPhases(source).phases[0]?.block.summaryLine).toBe('read 1 file');
  details.ref.executionId = carrier.id;
  carrier.rootWorkCommandId = 'foreign-work';
  expect(projectInkExplorationPhases(source).phases[0]?.block.summaryLine).toBe('read 1 file');
  carrier.rootWorkCommandId = 'work';
  details.presentation = 'standalone';
  expect(projectInkExplorationPhases(source).phases[0]?.block.summaryLine).toBe('read 1 file');
  details.presentation = 'exploration';
  tool.definitionId = 'custom/shell.execute';
  expect(projectInkExplorationPhases(source).phases[0]?.block.summaryLine).toBe('read 1 file');
});
test('active original Run keeps a completed read phase live until final answer classification', () => {
  const source = fixture([['read']]);
  Object.assign(source.view.runs[0]!, { status: 'running', isActive: true, finishedAt: null });
  expect(projectInkExplorationPhases(source).phases[0]!.block.active).toBe(true);
  (source.messages as Message[]).push({
    id: 'answer',
    seq: '2',
    sessionId: 'session',
    runId: 'run',
    role: 'assistant',
    status: 'incomplete',
    content: 'BUFFERED',
    sourceIds: ['answer-model'],
  });
  source.view.executions.push(
    execution('answer-model', { kind: 'model', definitionId: 'model', status: 'running' }),
  );
  expect([...projectInkExplorationPhases(source).bufferedAnswerMessageIds]).toEqual(['answer']);
});
test('reason-first buffers complete components; content-first and late reasoning preserve the answer owner', () => {
  const first = advanceInkModelStream(undefined, {
    identity: 'source',
    content: '',
    reasoning: 'prefix',
    complete: false,
  });
  const pending = advanceInkModelStream(first, {
    identity: 'source',
    content: 'FIRST\n\nFINAL',
    reasoning: 'prefix suffix',
    complete: false,
  });
  expect(inkModelStreamVisibility(pending)).toEqual({
    content: '',
    reasoning: 'prefix suffix',
    buffered: true,
  });
  const complete = advanceInkModelStream(pending, {
    identity: 'source',
    content: pending.content,
    reasoning: pending.reasoning,
    complete: true,
    toolCallCount: 0,
  });
  expect(inkModelStreamVisibility(complete)).toEqual({
    content: 'FIRST\n\nFINAL',
    reasoning: '',
    buffered: false,
  });
  const answer = advanceInkModelStream(undefined, {
    identity: 'content-first',
    content: 'VISIBLE',
    reasoning: '',
    complete: false,
  });
  const late = advanceInkModelStream(answer, {
    identity: 'content-first',
    content: 'VISIBLE FINAL',
    reasoning: 'late private',
    complete: false,
  });
  expect(inkModelStreamVisibility(late)).toEqual({
    content: 'VISIBLE FINAL',
    reasoning: '',
    buffered: false,
  });
  expect(
    advanceInkModelStream(complete, {
      identity: 'source',
      content: 'stale',
      reasoning: 'late',
      complete: false,
    }),
  ).toBe(complete);
  expect(
    advanceInkModelStream(late, {
      identity: 'content-first',
      content: 'divergent',
      reasoning: 'late private',
      complete: false,
    }).content,
  ).toBe('VISIBLE FINAL');
});
test('producer firstOutput resolves batched channels without guessing arrival order', () => {
  const source = { identity: 'batched', content: 'ANSWER', reasoning: 'PRIVATE', complete: false };
  const contentFirst = advanceInkModelStream(undefined, { ...source, firstOutput: 'content' });
  expect(inkModelStreamVisibility(contentFirst)).toEqual({
    content: 'ANSWER',
    reasoning: '',
    buffered: false,
  });
  const reasonFirst = advanceInkModelStream(undefined, { ...source, firstOutput: 'reasoning' });
  expect(inkModelStreamVisibility(reasonFirst)).toEqual({
    content: '',
    reasoning: 'PRIVATE',
    buffered: true,
  });
  const unclassified = advanceInkModelStream(reasonFirst, {
    ...source,
    firstOutput: 'reasoning',
    complete: true,
  });
  expect(unclassified.complete).toBe(false);
  expect(inkModelStreamVisibility(unclassified).buffered).toBe(true);
});

test('a terminal reasoning suffix flushes once before its answer and never reappears on replay', () => {
  const live = advanceInkModelStream(undefined, {
    identity: 'original',
    content: '',
    reasoning: 'prefix',
    firstOutput: 'reasoning',
    complete: false,
  });
  const terminal = advanceInkModelStream(live, {
    identity: 'original',
    content: 'answer',
    reasoning: 'prefix suffix',
    firstOutput: 'reasoning',
    complete: true,
    toolCallCount: 0,
  });
  expect(terminal.complete).toBe(true);
  expect(terminal.finalReasoningPreview).toBe(true);
  expect(inkModelStreamVisibility(terminal)).toEqual({
    content: '',
    reasoning: 'prefix suffix',
    buffered: true,
  });
  const flushed = settleInkModelStream(terminal);
  expect(inkModelStreamVisibility(flushed)).toEqual({
    content: 'answer',
    reasoning: '',
    buffered: false,
  });
  expect(
    advanceInkModelStream(flushed, {
      identity: 'original',
      content: 'answer',
      reasoning: 'prefix suffix',
      complete: true,
      toolCallCount: 0,
    }),
  ).toBe(flushed);
  const replay = advanceInkModelStream(undefined, {
    identity: 'original',
    content: 'answer',
    reasoning: 'prefix suffix',
    firstOutput: 'reasoning',
    complete: true,
    toolCallCount: 0,
  });
  expect(replay.finalReasoningPreview).toBe(false);
  expect(inkModelStreamVisibility(replay)).toEqual({
    content: 'answer',
    reasoning: '',
    buffered: false,
  });
});
test('only original completed Model durations accumulate and a write boundary never charges one invocation twice', () => {
  const source = fixture([['before', 'write', 'after'], []]);
  source.view.executions.find((item) => item.id === 'write')!.definitionId =
    'builtin.files/files.write';
  const timed = {
    ...source,
    executionTimings: {
      'model-0': { availability: 'recorded_dispatch' as const, startedAt: 100, finishedAt: 250 },
      'model-1': { availability: 'recorded_dispatch' as const, startedAt: 300, finishedAt: 500 },
    },
  };
  const phases = projectInkExplorationPhases(timed).phases;
  expect(phases.map((phase) => phase.block.totalElapsedMs)).toEqual([150, 200]);
  expect(
    projectInkExplorationPhases({
      ...timed,
      executionTimings: {
        'model-0': { availability: 'unavailable' },
        'model-1': timed.executionTimings['model-1'],
      },
    }).phases[0]!.block.totalElapsedMs,
  ).toBeUndefined();
});

test('retry presentation requires the real failed predecessor in the exact original work', () => {
  const previous = execution('first', {
    kind: 'model',
    status: 'failed',
    result: { code: 'MODEL_ATTEMPT_RETRYABLE_FAILURE:connection_failed' },
  });
  const next = execution('second', {
    kind: 'model',
    modelRetry: {
      previousExecutionId: 'first',
      attempt: 2,
      maxAttempts: 5,
      reason: 'connection_failed',
    },
  });
  expect(observedModelRetry(next, [previous, next])).toEqual(next.modelRetry);
  expect(observedModelRetry(next, [{ ...previous, rootWorkSeq: '2' }, next])).toBeUndefined();
  expect(
    observedModelRetry(next, [{ ...previous, status: 'outcome_unknown' }, next]),
  ).toBeUndefined();
  expect(observedModelRetry(next, [next])).toBeUndefined();
  const fifth = {
    ...previous,
    id: 'fifth',
    modelRetry: { ...next.modelRetry!, attempt: 5, maxAttempts: null },
  };
  const sixth = {
    ...next,
    modelRetry: {
      ...next.modelRetry!,
      previousExecutionId: 'fifth',
      attempt: 6,
      maxAttempts: null,
    },
  };
  expect(observedModelRetry(sixth, [fifth, sixth])).toEqual(sixth.modelRetry);
});

test('queued or cancelled exploration retains its actual row without claiming performed file searches', () => {
  for (const status of ['queued', 'cancelled', 'rejected'] as const) {
    const tool = {
      callId: 'original-search',
      name: 'search_files',
      args: { pattern: '*.md' },
      status,
      ok: false,
      summary: 'original state',
    };
    expect(buildToolSummaryLine([tool])).not.toContain('searched');
    const ui = render(
      <ToolSummaryBlock
        columns={80}
        block={{
          id: 0,
          kind: 'tool_summary',
          createdAt: 0,
          tools: [tool],
          summaryLine: buildToolSummaryLine([tool]),
          active: status === 'queued',
          hasThinking: false,
          hasThought: false,
        }}
      />,
    );
    try {
      expect(ui.lastFrame()).not.toContain('searched 1 file pattern');
    } finally {
      ui.unmount();
    }
  }
  expect(
    buildToolSummaryLine([
      {
        callId: 'actual-search',
        name: 'search_files',
        args: { pattern: '*.md' },
        status: 'done',
        ok: true,
        summary: 'actual result',
      },
    ]),
  ).toBe('searched 1 file pattern');
});
test('missing pending Execution material cannot seal an incomplete original read batch', () => {
  const complete = fixture([['first', 'second', 'third'], []]);
  const source = { ...complete, messages: complete.messages.slice(0, -1) };
  const original = [...source.view.executions];
  source.view.runs[0]!.isActive = true;
  source.view.executions = original.filter(
    (item) => !['second', 'third', 'model-1'].includes(item.id),
  );
  const pending = projectInkExplorationPhases(source);
  expect(pending.phases).toHaveLength(1);
  expect(pending.phases[0]!.block.active).toBe(true);
  expect(pending.phases[0]!.block.summaryLine).toBe('read 1 file');
  source.view.executions = original.filter((item) => item.id !== 'model-1');
  const full = projectInkExplorationPhases(source);
  expect(full.phases[0]!.key).toBe(pending.phases[0]!.key);
  expect(full.phases[0]!.block.summaryLine).toBe('read 3 files');
  expect(full.phases[0]!.block.active).toBe(true);
});

test('main keeps source-proven content-first exploration compact while retaining its real failed Shell detail', async () => {
  const original = fixture([['read', 'shell'], ['read-again'], []]);
  const source: TuiSnapshot = {
    ...original,
    messages: [
      {
        id: 'greeting',
        sessionId: 'session',
        runId: 'prior-run',
        seq: '1',
        role: 'assistant',
        status: 'complete',
        content: '请问你想做什么？',
      },
      ...original.messages.map((message) => ({
        ...message,
        seq: String(BigInt(message.seq) + 1n),
        firstOutput: 'content' as const,
      })),
    ],
  };
  const tool = source.view.executions.find((item) => item.id === 'shell')!;
  Object.assign(tool, {
    definitionId: 'builtin.shell/shell.execute',
    status: 'failed',
    toolInput: { command: 'git status --short' },
    result: {
      outcome: 'failed',
      content: 'original failed Shell',
      details: {
        presentation: 'exploration',
        ref: {
          executionId: 'carrier',
          originStoreId: 'store',
          sessionId: 'session',
          extensionId: 'builtin.shell',
          commandId: 'original-command',
          key: 'original-key',
        },
      },
    },
  });
  source.view.executions.push(
    execution('carrier', {
      kind: 'job',
      runId: null,
      definitionId: 'shell.command',
      parentExecutionId: tool.id,
      status: 'failed',
      result: { outcome: 'failed', content: 'fatal: original not-a-repository failure' },
    }),
  );
  let writes = 0;
  const forbidden = async () => {
    writes++;
    throw Error('read-only presentation');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'unused',
    readSession: async () => source,
    listSessions: async () => [],
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const controller = new TuiController(port);
  await controller.select('session');
  const app = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(40);
    const frame = app.lastFrame()!;
    expect(frame).not.toContain('narration-0');
    expect(frame).not.toContain('narration-1');
    expect(frame).toContain('read 2 files');
    expect(frame).toContain('ran 1 shell command');
    expect(frame).toContain('fatal: original not-a-repository failure');
    expect(frame.match(/fatal: original not-a-repository failure/g)).toHaveLength(1);
    expect(frame).toContain('ANSWER');
    expect(frame).toContain('请问你想做什么？');
    expect(writes).toBe(0);
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('standalone questions and writes, and a single read without Thought, retain their original narration', () => {
  for (const definitionId of ['ask_user', 'files.write', 'files.read']) {
    const original = fixture([['original-call'], []]);
    const source: TuiSnapshot = {
      ...original,
      messages: original.messages.map((message) => ({ ...message, firstOutput: 'content' })),
    };
    const tool = source.view.executions.find((item) => item.id === 'original-call')!;
    Object.assign(tool, { definitionId });
    const projection = projectInkExplorationPhases(source, new Map());
    expect(projection.suppressedNarrationMessageIds.has('message-0')).toBe(false);
    expect(source.messages[0]!.content).toBe('narration-0');
    expect(source.messages[1]!.content).toBe('ANSWER');
    expect(projection.phases).toHaveLength(definitionId === 'files.read' ? 1 : 0);
  }
});

test('a single read without Thinking keeps its actual result instead of an empty exploration statistic', async () => {
  const settled = fixture([['original-call'], []]);
  settled.view.executions.find((item) => item.id === 'original-call')!.result = {
    content: 'planning-baseline.txt · exact original readonly result',
  };
  let source = fixture([['original-call']]);
  source.view.runs[0]!.isActive = true;
  source.view.executions.find((item) => item.id === 'original-call')!.status = 'running';
  const forbidden = async () => {
    throw Error('read-only presentation');
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => 'unused',
    readSession: async () => source,
    listSessions: async () => [],
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  };
  const controller = new TuiController(port);
  await controller.select('session');
  const app = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(40);
    expect(app.lastFrame()?.match(/Read.*original\.ts/g)).toHaveLength(1);
    source = settled;
    await controller.select('session');
    await Bun.sleep(40);
    expect(app.lastFrame()).toContain('narration-0');
    expect(app.lastFrame()).toContain('read 1 file');
    expect(app.lastFrame()).toContain('planning-baseline.txt · exact original readonly result');
    expect(app.lastFrame()).toContain('ANSWER');
  } finally {
    app.unmount();
    controller.dispose();
  }
});

test('a live exact Shell carrier with no Run ID replaces its foreground wrapper once', async () => {
  let source = fixture([['original-call', 'read-next']]);
  source.messages[0]!.toolCalls = [
    {
      id: 'original-call',
      name: 'shell.execute',
      arguments: '{"command":"pwd"}',
    },
    { id: 'read-next', name: 'files.read', arguments: '{"path":"original.ts"}' },
  ];
  const producer = source.view.executions.find((item) => item.id === 'original-call')!;
  Object.assign(producer, {
    definitionId: 'builtin.shell/shell.execute',
    toolInput: { command: 'pwd' },
    status: 'running',
    result: null,
  });
  source.view.runs[0]!.isActive = true;
  source.view.executions = [
    ...source.view.executions,
    execution('carrier', {
      kind: 'job',
      runId: null,
      parentExecutionId: producer.id,
      definitionId: 'shell.command',
      status: 'running',
      result: null,
    }),
  ];
  const forbidden = async () => {
    throw Error('read-only presentation');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => 'unused',
    readSession: async () => source,
    listSessions: async () => [],
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  });
  await controller.select('session');
  const app = render(<TuiSession controller={controller} />);
  try {
    await Bun.sleep(40);
    expect(app.lastFrame()?.match(/Bash pwd/g)).toHaveLength(1);
    expect(app.lastFrame()!.indexOf('Bash pwd')).toBeLessThan(
      app.lastFrame()!.indexOf('Read original.ts'),
    );
    producer.status = 'cancelled';
    const carrier = source.view.executions.find((item) => item.id === 'carrier')!;
    carrier.status = 'cancelled';
    carrier.result = { outcome: 'cancelled', content: 'ORIGINAL_CANCELLED_SHELL_HISTORY' };
    source.view.runs[0]!.isActive = false;
    source.view.runs = [
      ...source.view.runs,
      {
        ...source.view.runs[0]!,
        id: 'next-run',
        originCommandId: 'next-command',
        isActive: true,
        status: 'running',
      },
    ];
    source = {
      ...source,
      messages: [
        ...source.messages,
        {
          id: 'original-result',
          seq: '2',
          sessionId: 'session',
          runId: 'run',
          role: 'tool',
          status: 'complete',
          toolCallId: 'original-call',
          sourceIds: [producer.id],
          content: 'FOREGROUND_PROTOCOL_ALREADY_OWNED_BY_CARRIER',
        },
        {
          id: 'next-user',
          seq: '3',
          sessionId: 'session',
          runId: 'next-run',
          role: 'user',
          status: 'complete',
          content: 'ACTUAL_SUCCESSOR_USER_BOUNDARY',
        },
      ],
    };
    await controller.select('session');
    await Bun.sleep(40);
    const frame = app.lastFrame()!;
    expect(frame).toContain('ORIGINAL_CANCELLED_SHELL_HISTORY');
    expect(frame).not.toContain('FOREGROUND_PROTOCOL_ALREADY_OWNED_BY_CARRIER');
    expect(frame.indexOf('ORIGINAL_CANCELLED_SHELL_HISTORY')).toBeLessThan(
      frame.indexOf('ACTUAL_SUCCESSOR_USER_BOUNDARY'),
    );
  } finally {
    app.unmount();
    controller.dispose();
  }
});
