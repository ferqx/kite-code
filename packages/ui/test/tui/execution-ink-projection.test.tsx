import { expect, test } from 'bun:test';
import type { Execution, Message, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiChildSessionPanel } from '../../src/tui/child-session-panel';
import type { TuiSnapshot } from '../../src/tui/controller';
import {
  InkExecution,
  inkToolArguments,
  inkToolName,
  projectInkChild,
  projectInkThought,
  projectInkTool,
} from '../../src/tui/execution-projection';
import type { TuiChildLog } from '../../src/tui/executions';

const execution = (id: string, extra: Partial<Execution> = {}): Execution => ({
  id,
  originStoreId: 'store',
  sessionId: 'parent',
  runId: 'run',
  kind: 'tool',
  definitionId: 'builtin.files/files.read',
  definitionVersion: '1',
  status: 'succeeded',
  result: { content: 'original body' },
  resultRevision: '1',
  cancelRequestedAt: null,
  parentExecutionId: null,
  childSessionId: null,
  ...extra,
});
const message = (id: string, seq: string, extra: Partial<Message> = {}): Message => ({
  id,
  seq,
  sessionId: 'parent',
  runId: 'run',
  role: 'assistant',
  status: 'complete',
  content: 'original',
  ...extra,
});
const view = (id = 'parent', extra: Partial<SessionView> = {}): SessionView => ({
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
    nextSeq: '30',
    deletedAt: null,
  },
  runs: [],
  executions: [],
  messages: [],
  ...extra,
});
const snapshot = (executions: Execution[], messages: Message[] = []): TuiSnapshot => ({
  storeId: 'store',
  view: view('parent', { executions }),
  messages,
  interactions: [],
});
test('original Tool input is scoped and call arguments use only a unique exact source identity', () => {
  const source = execution('tool', { toolCallId: 'original-call' }),
    owner = message('owner', '1', {
      toolCalls: [{ id: 'original-call', name: 'same-name', arguments: '{"path":"original.ts"}' }],
    });
  expect(inkToolArguments(source, snapshot([source], [owner]))).toEqual({ path: 'original.ts' });
  expect(
    inkToolArguments({ ...source, originStoreId: 'foreign' }, snapshot([source], [owner])),
  ).toBeUndefined();
  expect(
    inkToolArguments(source, snapshot([source], [owner, { ...owner, id: 'duplicate', seq: '2' }])),
  ).toBeUndefined();
  expect(
    inkToolArguments(source, snapshot([source], [{ ...owner, runId: 'other' }])),
  ).toBeUndefined();
  expect(
    inkToolArguments({ ...source, toolInput: { path: 'saved.ts' } }, snapshot([source], [owner])),
  ).toEqual({ path: 'saved.ts' });
  expect(inkToolName('custom/same-name')).toBe('custom/same-name');
});
test('original builtin friendly card uses actual content and only confirmed execution time', () => {
  const source = execution('tool', { toolInput: { path: 'src/original.ts' } }),
    facts = snapshot([source]);
  const block = projectInkTool(source, facts);
  expect(block).toMatchObject({
    name: 'read_file',
    args: { path: 'src/original.ts' },
    summary: 'original body',
    status: 'done',
  });
  expect(block.elapsedMs).toBeUndefined();
  const app = render(<InkExecution execution={source} snapshot={facts} expanded columns={80} />);
  try {
    expect(app.lastFrame()).toContain('Read');
    expect(app.lastFrame()).toContain('original.ts');
    expect(app.lastFrame()).not.toContain('(1s)');
  } finally {
    app.unmount();
  }
});
test('child tree requires exact task carrier relationship, and public child scope validates before steps', () => {
  const parent = execution('task', {
      definitionId: 'builtin.task/task',
      toolInput: { role: 'explore', key: 'original-task', input: 'Investigate original' },
    }),
    carrier = execution('carrier', {
      kind: 'job',
      definitionId: 'agent/explore',
      parentExecutionId: 'task',
      childSessionId: 'child',
      status: 'running',
    });
  const childTool = execution('child-tool', {
      sessionId: 'child',
      toolInput: { path: 'src/child.ts' },
    }),
    child = view('child', { executions: [childTool] });
  const facts = {
    ...snapshot([parent, carrier]),
    childViews: [{ executionId: 'carrier', view: child }],
  };
  const pendingTool = {
    ...childTool,
    status: 'planned' as const,
    authorization: {
      dispatched: false,
      human: {
        interactionId: 'question',
        state: 'pending' as const,
        revision: '1',
        acceptedDecisionRevision: null,
        accepted: false,
        decision: null,
      },
    },
  };
  const waiting = {
    ...facts,
    childViews: [{ executionId: 'carrier', view: { ...child, executions: [pendingTool] } }],
  };
  expect(projectInkChild(carrier, waiting)).toMatchObject({
    awaitingApproval: true,
    approvalState: 'awaiting_user',
  });
  expect(projectInkChild(carrier, facts)).toMatchObject({
    role: 'explore',
    task: 'Investigate original',
    steps: [{ stepId: 'child-tool', toolArgs: { path: 'src/child.ts' } }],
  });
  expect(projectInkChild({ ...carrier, parentExecutionId: 'other' }, facts)).toBeUndefined();
  expect(
    projectInkChild(carrier, {
      ...facts,
      childViews: [{ executionId: 'carrier', view: { ...child, storeId: 'foreign' } }],
    })?.steps,
  ).toEqual([]);
  expect(
    projectInkChild(carrier, snapshot([{ ...parent, definitionId: 'custom/task' }, carrier])),
  ).toBeUndefined();
});
test('Thought tool count is one original Model message, never same-name calls from another Run', () => {
  const tool = execution('tool', { toolCallId: 'original' }),
    owner = message('owner', '1', {
      toolCalls: [{ id: 'original', name: 'read', arguments: '{"path":"original.ts"}' }],
    });
  expect(projectInkThought(owner, snapshot([tool])).tools).toMatchObject([
    { status: 'done', args: { path: 'original.ts' } },
  ]);
  expect(projectInkThought(owner, snapshot([{ ...tool, runId: 'foreign' }])).tools).toMatchObject([
    { status: 'queued', summary: '' },
  ]);
  expect(projectInkThought(owner, snapshot([tool])).totalElapsedMs).toBeUndefined();
});
test('verified child reader retains list/detail escape levels and three-line scrolling without issuing work', async () => {
  const carrier = execution('carrier', {
      kind: 'job',
      childSessionId: 'child',
      parentExecutionId: 'task',
    }),
    messages = Array.from({ length: 25 }, (_, n) =>
      message(`message-${n}`, String(n + 1), {
        sessionId: 'child',
        content: Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n'),
      }),
    );
  const child: TuiChildLog = {
    target: {
      storeId: 'store',
      originStoreId: 'store',
      sessionId: 'parent',
      executionId: 'carrier',
      definitionId: carrier.definitionId,
      definitionVersion: '1',
    },
    carrier,
    view: view('child'),
    messages,
    modelOutputs: new Map(),
  };
  let backs = 0,
    refreshes = 0;
  const app = render(
    <TuiChildSessionPanel child={child} onBack={() => backs++} onRefresh={() => refreshes++} />,
  );
  const tick = () => Bun.sleep(25);
  try {
    await tick();
    expect(app.lastFrame()).toContain('History fully read');
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('Lines 1');
    app.stdin.write('\u001b[B');
    await tick();
    expect(app.lastFrame()).toContain('Lines 4');
    app.stdin.write('r');
    await tick();
    expect(refreshes).toBe(1);
    app.stdin.write('\u001b');
    await tick();
    expect(backs).toBe(0);
    app.stdin.write('\u001b');
    await tick();
    expect(backs).toBe(1);
  } finally {
    app.unmount();
  }
});

test('Shell Job card uses only the actual original launch parent command and current qualified tail', () => {
  const launch = execution('launch', {
    definitionId: 'builtin.shell/shell.launch',
    toolInput: { key: 'original', command: 'printf original' },
  });
  const shell = execution('shell', {
    kind: 'job',
    definitionId: 'shell.command',
    parentExecutionId: 'launch',
    status: 'running',
  });
  const facts = {
    ...snapshot([launch, shell]),
    jobTails: [
      { executionId: 'shell', content: 'actual stdout\nlast row', totalLines: 9, incomplete: true },
    ],
  };
  expect(projectInkTool(shell, facts)).toMatchObject({
    name: 'shell_execute',
    args: { command: 'printf original', key: 'original' },
    liveOutput: 'actual stdout\nlast row',
    liveTotalLines: 9,
  });
  const app = render(<InkExecution execution={shell} snapshot={facts} columns={80} />);
  try {
    expect(app.lastFrame()).toContain('Bash');
    expect(app.lastFrame()).toContain('printf original');
    expect(app.lastFrame()).toContain('actual stdout');
    expect(app.lastFrame()).toContain('Output preview incomplete');
  } finally {
    app.unmount();
  }
  expect(
    projectInkTool(shell, {
      ...facts,
      view: { ...facts.view, executions: [{ ...launch, originStoreId: 'foreign' }, shell] },
    }).name,
  ).toBe('shell.command');
  expect(projectInkTool({ ...shell, parentExecutionId: 'missing' }, facts).name).toBe(
    'shell.command',
  );
});

test('formal short builtin IDs use frozen registered extension proof instead of same-name guesses', () => {
  const read = execution('read', {
    definitionId: 'files.read',
    toolCallId: 'read-call',
    toolInput: { path: 'formal.ts' },
  });
  const facts = snapshot([read]);
  facts.view.runs = [
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
  ];
  expect(projectInkTool(read, facts).name).toBe('read_file');
  expect(projectInkTool(read, snapshot([read])).name).toBe('files.read');
});

test('readonly aggregation consumes consecutive exact original calls and frozen read-only definitions', async () => {
  const { projectInkExecutionGroups, InkExecutionGroupView } = await import(
    '../../src/tui/execution-projection'
  );
  const one = execution('read-one', {
      definitionId: 'files.read',
      toolCallId: 'call-one',
      toolInput: { path: 'one.ts' },
      status: 'running',
    }),
    two = execution('read-two', {
      definitionId: 'files.read',
      toolCallId: 'call-two',
      toolInput: { path: 'two.ts' },
      status: 'running',
    }),
    model = execution('model', { kind: 'model', definitionId: 'model' });
  const owner = message('batch', '1', {
    sourceIds: ['model'],
    toolCalls: [
      { id: 'call-one', name: 'files.read', arguments: '{"path":"one.ts"}' },
      { id: 'call-two', name: 'files.read', arguments: '{"path":"two.ts"}' },
    ],
  });
  const facts = snapshot([model, one, two], [owner]);
  facts.view.runs = [
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
  ];
  const groups = projectInkExecutionGroups(facts);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    kind: 'readonly_tools',
    executionIds: ['read-one', 'read-two'],
    block: { summaryLine: 'read 2 files', active: true },
  });
  const app = render(<InkExecutionGroupView group={groups[0]!} columns={80} />);
  try {
    expect(app.lastFrame()).toContain('read 2 files');
    expect(app.lastFrame()).toContain('one.ts');
    expect(app.lastFrame()).toContain('two.ts');
  } finally {
    app.unmount();
  }
  expect(projectInkExecutionGroups({ ...facts, view: { ...facts.view, runs: [] } })).toEqual([]);
  expect(
    projectInkExecutionGroups({
      ...facts,
      messages: [owner, { ...owner, id: 'duplicated-batch', seq: '2' }],
    }),
  ).toEqual([]);
});

test('ConcurrentSubAgent groups only one actual Model call batch with overlapping original child lifetimes', async () => {
  const { projectInkExecutionGroups, InkExecutionGroupView } = await import(
    '../../src/tui/execution-projection'
  );
  const model = execution('model', { kind: 'model', definitionId: 'model' }),
    first = execution('task-one', {
      definitionId: 'task',
      toolCallId: 'one',
      toolInput: { role: 'explore', input: 'first child' },
    }),
    second = execution('task-two', {
      definitionId: 'task',
      toolCallId: 'two',
      toolInput: { role: 'code', input: 'second child' },
    }),
    a = execution('a', {
      kind: 'job',
      definitionId: 'agent/explore',
      parentExecutionId: 'task-one',
      childSessionId: 'a-child',
      status: 'running',
    }),
    b = execution('b', {
      kind: 'job',
      definitionId: 'agent/code',
      parentExecutionId: 'task-two',
      childSessionId: 'b-child',
      status: 'running',
    });
  const owner = message('actual-batch', '1', {
    sourceIds: ['model'],
    toolCalls: [
      { id: 'one', name: 'task', arguments: '{}' },
      { id: 'two', name: 'task', arguments: '{}' },
    ],
  });
  const facts = snapshot([model, first, second, a, b], [owner]);
  facts.view.runs = [
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
      configuration: {
        snapshot: {
          planning: {
            binding: {
              tools: [
                { extensionId: 'builtin.task', definitionId: 'task', definitionVersion: '1' },
              ],
              readOnlyDefinitions: [],
            },
          },
        },
      },
    },
  ];
  const groups = projectInkExecutionGroups(facts, new Map(), true);
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    kind: 'concurrent_subagents',
    executionIds: ['task-one', 'a', 'task-two', 'b'],
  });
  const app = render(<InkExecutionGroupView group={groups[0]!} columns={80} />);
  try {
    expect(app.lastFrame()).toContain('2 agents');
    expect(app.lastFrame()).toContain('first child');
    expect(app.lastFrame()).toContain('second child');
  } finally {
    app.unmount();
  }
  const separate = {
    ...facts,
    messages: [
      { ...owner, toolCalls: [owner.toolCalls![0]!] },
      { ...owner, id: 'second-batch', seq: '2', toolCalls: [owner.toolCalls![1]!] },
    ],
  };
  expect(projectInkExecutionGroups(separate)).toEqual([]);
  const settled = {
    ...facts,
    view: {
      ...facts.view,
      executions: [
        model,
        first,
        second,
        { ...a, status: 'succeeded' as const },
        { ...b, status: 'succeeded' as const },
      ],
    },
    executionTimings: {
      a: { availability: 'recorded_dispatch' as const, startedAt: 1, finishedAt: 2 },
      b: { availability: 'recorded_dispatch' as const, startedAt: 3, finishedAt: 4 },
    },
  };
  expect(projectInkExecutionGroups(settled)).toEqual([]);
  expect(
    projectInkExecutionGroups({
      ...settled,
      executionTimings: {
        ...settled.executionTimings,
        b: { availability: 'recorded_dispatch', startedAt: 1, finishedAt: 4 },
      },
    }),
  ).toHaveLength(1);
});

test('actual active Model with null result keeps live reasoning and only verified Model phase time', () => {
  const model = execution('active-model', {
    kind: 'model',
    definitionId: 'provider-model',
    status: 'dispatching',
    result: null,
  });
  const owner = message('partial-model', '1', {
      sourceIds: ['active-model'],
      status: 'incomplete',
    }),
    facts = snapshot([model], [owner]);
  const loaded = new Map([
    [
      owner.id,
      { content: '', reasoning: 'actual small live reasoning', toolCalls: [], complete: false },
    ],
  ]);
  expect(projectInkThought(owner, facts, loaded)).toMatchObject({
    active: true,
    latestActivity: { kind: 'thinking', text: 'actual small live reasoning' },
  });
  expect(projectInkThought(owner, facts, loaded).totalElapsedMs).toBeUndefined();
  expect(projectInkThought(owner, facts, loaded).liveModelStartedAt).toBeUndefined();
  const timed = {
    ...facts,
    executionTimings: {
      'active-model': { availability: 'recorded_dispatch' as const, startedAt: 1000 },
    },
  };
  expect(projectInkThought(owner, timed, loaded).liveModelStartedAt).toBe(1000);
  const settled = {
    ...timed,
    view: { ...timed.view, executions: [{ ...model, status: 'succeeded' as const }] },
    executionTimings: {
      'active-model': {
        availability: 'recorded_dispatch' as const,
        startedAt: 1000,
        finishedAt: 2500,
      },
    },
  };
  expect(projectInkThought(owner, settled, loaded)).toMatchObject({
    active: false,
    totalElapsedMs: 1500,
  });
});

test('MCP friendly names require all original Execution label identities; missing proof preserves the exact proxy ID', () => {
  const source = execution('mcp', {
      definitionId: 'mcp.server.hash',
      definitionVersion: 'version',
    }),
    facts = {
      ...snapshot([source]),
      toolLabels: [
        {
          executionId: 'mcp',
          originStoreId: 'store',
          sessionId: 'parent',
          definitionId: 'mcp.server.hash',
          definitionVersion: 'version',
          label: 'Actual server · Actual tool',
        },
      ],
    };
  expect(projectInkTool(source, facts).name).toBe('Actual server · Actual tool');
  expect(
    projectInkTool(source, {
      ...facts,
      toolLabels: [{ ...facts.toolLabels[0]!, definitionVersion: 'other' }],
    }).name,
  ).toBe(source.definitionId);
});
