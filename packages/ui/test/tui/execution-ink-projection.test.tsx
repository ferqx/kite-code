import { expect, test } from 'bun:test';
import type { Execution, Message, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import { TuiChildSessionPanel } from '../../src/tui/child-session-panel';
import type { TuiSnapshot } from '../../src/tui/controller';
import {
  InkExecution,
  inkShellCarrier,
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
  rootWorkCommandId: 'work',
  rootWorkSeq: '1',
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
test('only actual same-scope failed pre-dispatch approval denial receives the user rejection message', () => {
  const denied = execution('denied', {
    definitionId: 'builtin.files/files.write',
    definitionVersion: '2',
    status: 'failed',
    result: {
      outcome: 'failed',
      content: 'approval_denied',
      details: { code: 'approval_denied', dispatchCommitted: false, adapterAttempted: false },
    },
  });
  expect(projectInkTool(denied, snapshot([denied])).summary).toBe(
    'Tool approval rejected by user.',
  );
  const foreign = { ...denied, originStoreId: 'foreign' };
  expect(projectInkTool(foreign, snapshot([foreign])).summary).not.toBe(
    'Tool approval rejected by user.',
  );
  const unknown = { ...denied, status: 'outcome_unknown' as const };
  expect(projectInkTool(unknown, snapshot([unknown])).summary).toBe(
    'Outcome unknown; original work remains unverified.',
  );
  const attempted = {
    ...denied,
    result: {
      outcome: 'failed',
      content: 'approval_denied',
      details: { code: 'approval_denied', dispatchCommitted: true, adapterAttempted: true },
    },
  };
  expect(projectInkTool(attempted, snapshot([attempted])).summary).not.toBe(
    'Tool approval rejected by user.',
  );
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
test.each([
  'builtin.task/task',
  'builtin.task/task.execute',
])('child tree %s requires exact carrier relationship, and public child scope validates before steps', (definitionId) => {
  const parent = execution('task', {
      definitionId,
      toolInput: {
        role: definitionId.endsWith('task.execute') ? 'agent/explore' : 'explore',
        key: 'original-task',
        input: 'Investigate original',
      },
    }),
    carrier = execution('carrier', {
      kind: 'job',
      runId: null,
      definitionId: 'agent/explore',
      parentExecutionId: 'task',
      childSessionId: 'child',
      status: 'running',
    });
  const childTool = execution('child-tool', {
      sessionId: 'child',
      toolInput: { path: 'src/child.ts' },
    }),
    child = view('child', {
      executions: [childTool],
      runs: [{ ...view().runs[0]!, sessionId: 'child', originCommandId: 'child-start-carrier' }],
    });
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
  expect(projectInkChild({ ...carrier, rootWorkCommandId: 'other-work' }, facts)).toBeUndefined();
  expect(projectInkChild({ ...carrier, rootWorkSeq: '2' }, facts)).toBeUndefined();
  expect(projectInkChild({ ...carrier, runId: 'foreign-run' }, facts)).toBeUndefined();
  expect(projectInkChild(carrier, { ...facts, view: { ...facts.view, runs: [] } })).toBeUndefined();
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

test('spawn and follow-up cards pin their own Run and work when one stable child contains both histories', () => {
  const spawn = execution('spawn', {
    definitionId: 'builtin.task/task.spawn',
    toolInput: { prompt: 'Original work', taskName: 'Original colleague' },
  });
  const follow = execution('follow', {
    definitionId: 'builtin.task/task.follow_up',
    rootWorkCommandId: 'other-work',
    rootWorkSeq: '2',
    toolInput: { agentId: 'child', content: 'New work' },
  });
  const first = execution('carrier-one', {
    kind: 'job',
    runId: null,
    parentExecutionId: spawn.id,
    childSessionId: 'child',
    status: 'succeeded',
  });
  const second = execution('carrier-two', {
    kind: 'job',
    runId: null,
    parentExecutionId: follow.id,
    childSessionId: 'child',
    rootWorkCommandId: 'other-work',
    rootWorkSeq: '2',
    status: 'running',
  });
  const oldTool = execution('old-tool', {
    sessionId: 'child',
    runId: 'first-run',
    status: 'planned',
    authorization: {
      dispatched: false,
      human: {
        interactionId: 'old-approval',
        state: 'pending',
        revision: '1',
        acceptedDecisionRevision: null,
        accepted: false,
        decision: null,
      },
    },
  });
  const newTool = execution('new-tool', {
    sessionId: 'child',
    runId: 'second-run',
    rootWorkCommandId: 'other-work',
    rootWorkSeq: '2',
    status: 'planned',
    authorization: {
      dispatched: false,
      human: {
        interactionId: 'new-approval',
        state: 'pending',
        revision: '1',
        acceptedDecisionRevision: null,
        accepted: false,
        decision: null,
      },
    },
  });
  const child = view('child', {
    executions: [oldTool, newTool, { ...newTool, id: 'foreign-work', rootWorkCommandId: 'wrong' }],
    runs: [
      {
        ...view().runs[0]!,
        id: 'first-run',
        sessionId: 'child',
        originCommandId: 'child-start-carrier-one',
        isActive: false,
        status: 'completed',
      },
      {
        ...view().runs[0]!,
        id: 'second-run',
        sessionId: 'child',
        originCommandId: 'child-start-carrier-two',
      },
    ],
  });
  const facts = {
    ...snapshot([spawn, follow, first, second]),
    childViews: [
      { executionId: first.id, view: child },
      { executionId: second.id, view: child },
    ],
  };
  const oldCard = projectInkChild(first, facts)!;
  const newCard = projectInkChild(second, facts)!;
  expect(oldCard).toMatchObject({
    task: 'Original colleague',
    role: 'worker',
    status: 'done',
    steps: [{ stepId: 'old-tool' }],
  });
  expect(oldCard.awaitingApproval).toBeUndefined();
  expect(newCard).toMatchObject({
    task: 'New work',
    steps: [{ stepId: 'new-tool' }],
    approvalState: 'awaiting_user',
  });
  expect(newCard.steps).toHaveLength(1);
  const continued = {
    ...child,
    executions: [...child.executions, { ...newTool, id: 'report-tool', runId: 'report-run' }],
    runs: [
      ...child.runs.map((run) => ({ ...run, isActive: false })),
      {
        ...child.runs[1]!,
        id: 'report-run',
        originCommandId: 'report-exact-result',
        carrierExecutionId: second.id,
        rootWorkCommandId: second.rootWorkCommandId,
        rootWorkSeq: second.rootWorkSeq,
        isActive: true,
      },
    ],
  };
  const reportCard = projectInkChild(second, {
    ...facts,
    childViews: [{ executionId: second.id, view: continued }],
  })!;
  expect(reportCard.steps.map((step) => step.stepId)).toEqual(['new-tool', 'report-tool']);
  expect(reportCard.approvalState).toBe('awaiting_user');
  expect(
    projectInkChild(second, {
      ...facts,
      childViews: [
        {
          executionId: second.id,
          view: {
            ...continued,
            runs: continued.runs.map((run) =>
              run.id === 'report-run' ? { ...run, carrierExecutionId: first.id } : run,
            ),
          },
        },
      ],
    })!.steps.map((step) => step.stepId),
  ).toEqual(['new-tool']);
  const app = render(<InkExecution execution={second} snapshot={facts} expanded columns={80} />);
  try {
    expect(app.lastFrame()).toContain('等待你的批准');
  } finally {
    app.unmount();
  }
  expect(
    projectInkChild({ ...second, cancelRequestedAt: 10 }, facts)?.awaitingApproval,
  ).toBeUndefined();
  expect(
    projectInkChild(second, {
      ...facts,
      childViews: [{ executionId: second.id, view: { ...child, runs: [] } }],
    })?.steps,
  ).toEqual([]);
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
test('a child builtin label uses exact Core-frozen registered tools when its role has no planning binding', () => {
  const search = execution('search', {
    definitionId: 'files.search',
    definitionVersion: '2',
    toolInput: { path: '.', query: 'source' },
  });
  const facts = snapshot([search]);
  facts.view.runs[0]!.configuration = {
    tools: [{ id: 'files.search', version: '2', extensionId: 'builtin.files' }],
  };
  expect(projectInkTool(search, facts).name).toBe('search_content');
  expect(projectInkTool({ ...search, definitionVersion: '1' }, facts).name).toBe('files.search');
  facts.view.runs[0]!.configuration = {
    tools: [{ id: 'files.search', version: '2', extensionId: 'custom.files' }],
  };
  expect(projectInkTool(search, facts).name).toBe('files.search');
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
test('actual MCP proxy cards keep call bodies private and use only scoped catalogue discovery for names', () => {
  const id = `mcp.mcp-${'a'.repeat(64)}.${'b'.repeat(32)}`;
  const tool = execution('proxy', {
    definitionId: id,
    toolInput: { message: 'private input' },
    result: { content: 'private remote body' },
  });
  const facts = {
    ...snapshot([tool]),
    toolLabels: [
      {
        executionId: tool.id,
        originStoreId: 'store',
        sessionId: 'parent',
        definitionId: id,
        definitionVersion: '1',
        label: 'private source label',
      },
    ],
  };
  expect(projectInkTool(tool, facts)).toMatchObject({ name: 'mcp_tool', args: {}, summary: '' });
  const search = execution('search', {
    definitionId: 'mcp.tools.search',
    result: {
      content: JSON.stringify({
        source: 'frozen_selected_mcp_catalogue',
        items: [
          {
            serverId: `mcp-${'a'.repeat(64)}`,
            definitionId: id,
            definitionVersion: '1',
            remoteName: 'search documentation / latest',
          },
        ],
      }),
    },
  });
  const discovered = { ...facts, view: { ...facts.view, executions: [search, tool] } };
  expect(projectInkTool(tool, discovered)).toMatchObject({
    name: 'mcp:dynamic_tool',
    preview: 'search documentation / latest',
    detail: 'search documentation / latest',
    args: {},
    summary: '',
  });
  const app = render(
    <InkExecution execution={tool} snapshot={discovered} expanded columns={100} />,
  );
  expect(app.lastFrame()).toContain('mcp:dynamic_tool');
  expect(app.lastFrame()).toContain('search documentation / latest');
  expect(app.lastFrame()).not.toContain('private input');
  expect(app.lastFrame()).not.toContain('private remote body');
  app.unmount();
  expect(
    projectInkTool(tool, {
      ...discovered,
      view: { ...facts.view, executions: [{ ...search, sessionId: 'foreign' }, tool] },
    }).preview,
  ).toBeUndefined();
  expect(
    projectInkTool(tool, {
      ...discovered,
      view: { ...facts.view, executions: [{ ...search, sessionId: 'foreign' }, tool] },
    }).detail,
  ).toBeUndefined();
});
test('MCP resource references require the exact source receipt while resource contents remain private', () => {
  const binding = {
    executionId: 'resources',
    runId: 'run',
    originalStoreId: 'store',
    sessionId: 'parent',
    definitionId: 'mcp.resources.list',
    definitionVersion: '1',
    inputDigest: 'a'.repeat(64),
    serverId: 'actual-server',
    connectionKey: 'connection',
    configDigest: 'b'.repeat(64),
    generation: 1,
  };
  const tool = execution('resources', {
    definitionId: binding.definitionId,
    toolInput: {
      serverId: binding.serverId,
      connectionKey: binding.connectionKey,
      configDigest: binding.configDigest,
      generation: binding.generation,
    },
    result: {
      content: 'private resource contents',
      details: {
        binding,
        recordKey: 'resources/resources',
        descriptors: [{ descriptor: { uri: 'docs://overview' }, descriptorDigest: 'digest' }],
      },
    },
  });
  const facts = snapshot([tool]);
  expect(projectInkTool(tool, facts)).toMatchObject({
    name: 'list_mcp_resources',
    summary: '',
    resourceReferences: ['docs://overview'],
  });
  const app = render(<InkExecution execution={tool} snapshot={facts} columns={100} />);
  expect(app.lastFrame()).toContain('docs://overview');
  expect(app.lastFrame()).not.toContain('private resource contents');
  app.unmount();
  expect(
    projectInkTool(
      {
        ...tool,
        result: {
          details: {
            binding: { ...binding, originalStoreId: 'foreign' },
            descriptors: [{ descriptor: { uri: 'docs://overview' } }],
          },
        },
      },
      facts,
    ).resourceReferences,
  ).toBeUndefined();
});
test('child display uses its actual input name and dispatch duration without fabricating missing timing', () => {
  const parent = execution('named-task', {
    definitionId: 'builtin.task/task',
    toolInput: {
      role: 'explore',
      key: 'named',
      input: { name: 'Same-name tool child', content: 'Read the original file' },
    },
  });
  const child = execution('named-carrier', {
    kind: 'job',
    definitionId: 'agent/explore',
    parentExecutionId: parent.id,
    childSessionId: 'named-child',
  });
  const facts = snapshot([parent, child]);
  expect(projectInkChild(child, facts)).toMatchObject({ task: 'Same-name tool child' });
  expect(projectInkChild(child, facts)?.durationMs).toBeUndefined();
  const timed = {
    ...facts,
    executionTimings: {
      [child.id]: { availability: 'recorded_dispatch' as const, startedAt: 100, finishedAt: 350 },
    },
  };
  expect(projectInkChild(child, timed)).toMatchObject({ startedAt: 100, durationMs: 250 });
  expect(
    projectInkChild(child, {
      ...timed,
      executionTimings: { [child.id]: { availability: 'unavailable' } },
    })?.startedAt,
  ).toBeUndefined();
});

test('Shell foreground carrier uses a unique exact saved reference and rejects foreign or ambiguous producers', () => {
  const ref = {
    executionId: 'carrier',
    originStoreId: 'store',
    sessionId: 'parent',
    extensionId: 'builtin.shell',
    commandId: 'command',
    key: 'original',
  };
  const producer = execution('producer', {
    definitionId: 'builtin.shell/shell.execute',
    toolInput: { command: 'printf original' },
    result: { details: { ref } },
  });
  const carrier = execution('carrier', {
    kind: 'job',
    definitionId: 'shell.command',
    result: { content: 'original stdout' },
  });
  const original = snapshot([producer, carrier]);
  expect(projectInkTool(carrier, original).name).toBe('shell_execute');
  expect(projectInkTool(carrier, original).args.command).toBe('printf original');
  expect(projectInkTool(producer, original).name).toBe('shell_execute');
  const nestedCarrier = { ...carrier, runId: null, parentExecutionId: producer.id };
  expect(inkShellCarrier(producer, snapshot([producer, nestedCarrier]))?.id).toBe('carrier');
  expect(projectInkTool(nestedCarrier, snapshot([producer, nestedCarrier])).summary).toBe(
    'original stdout',
  );
  expect(
    inkShellCarrier(
      producer,
      snapshot([producer, { ...nestedCarrier, rootWorkCommandId: 'foreign' }]),
    ),
  ).toBeUndefined();
  expect(
    inkShellCarrier(
      producer,
      snapshot([producer, nestedCarrier, { ...nestedCarrier, id: 'second-carrier' }]),
    ),
  ).toBeUndefined();
  const foreign = execution('producer', {
    ...producer,
    result: { details: { ref: { ...ref, originStoreId: 'foreign' } } },
  });
  expect(projectInkTool(carrier, snapshot([foreign, carrier])).name).toBe('shell.command');
  const duplicate = execution('duplicate', { ...producer, id: 'duplicate' });
  expect(projectInkTool(carrier, snapshot([producer, duplicate, carrier])).name).toBe(
    'shell.command',
  );
});

test('file changed display requires a successful scoped builtin receipt and both exact input/output baselines', () => {
  const after = { hash: 'a'.repeat(64), size: 1, device: '1', inode: '2' };
  const source = execution('write', {
    definitionId: 'builtin.files/files.write',
    definitionVersion: '2',
    toolInput: { path: 'original.txt', base: null },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({ path: 'original.txt', baseline: after }),
      details: {
        fileChange: {
          version: 1,
          format: 'file_content',
          path: 'original.txt',
          before: null,
          after,
          text: 'original text',
          truncated: false,
        },
      },
    },
  });
  expect(projectInkTool(source, snapshot([source])).fileNotice).toBe('Workspace file changed.');
  expect(
    projectInkTool(source, {
      ...snapshot([source]),
      environment: { workspacePath: 'file:///original%20workspace' },
    }).fileNotice,
  ).toBe('Workspace file changed.');
  expect(
    projectInkTool(source, {
      ...snapshot([source]),
      environment: { workspacePath: 'file:///C:/original%20workspace' },
    }).fileNotice,
  ).toBe('Workspace file changed.');
  for (const expanded of [false, true]) {
    const app = render(
      <InkExecution
        execution={source}
        snapshot={snapshot([source])}
        expanded={expanded}
        columns={80}
      />,
    );
    try {
      expect(app.lastFrame()?.split('Workspace file changed.')).toHaveLength(2);
    } finally {
      app.unmount();
    }
  }
  expect(projectInkTool(source, snapshot([source])).summary).toBe('original text');
  const unknown = execution('write', { ...source, status: 'outcome_unknown' });
  expect(projectInkTool(unknown, snapshot([unknown])).summary).not.toBe('Workspace file changed.');
  const foreign = execution('write', { ...source, originStoreId: 'foreign' });
  expect(projectInkTool(foreign, snapshot([foreign])).summary).not.toBe('Workspace file changed.');
  const mismatched = execution('write', {
    ...source,
    result: {
      ...(source.result as object),
      content: JSON.stringify({
        path: 'original.txt',
        baseline: { ...after, hash: 'b'.repeat(64) },
      }),
    },
  });
  expect(projectInkTool(mismatched, snapshot([mismatched])).summary).not.toBe(
    'Workspace file changed.',
  );
  const path = 'C:\\external\\original.txt';
  const external = execution('external', {
    ...source,
    id: 'external',
    toolInput: { path, base: null },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({ path, baseline: after }),
      details: {
        fileChange: {
          version: 1,
          format: 'file_content',
          path,
          before: null,
          after,
          text: 'original text',
          truncated: false,
        },
      },
    },
  });
  expect(
    projectInkTool(external, {
      ...snapshot([external]),
      environment: { workspacePath: 'C:\\workspace' },
    }).fileNotice,
  ).toBe('External file changed.');
  const noOp = execution('unchanged', {
    ...source,
    id: 'unchanged',
    toolInput: { path: 'original.txt', base: after },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({
        path: 'original.txt',
        baseline: after,
        summary: 'Wrote 1 lines to original.txt (content unchanged)',
      }),
      details: {
        fileChange: {
          version: 1,
          format: 'line_diff',
          path: 'original.txt',
          before: after,
          after,
          text: '',
          truncated: false,
        },
      },
    },
  });
  expect(projectInkTool(noOp, snapshot([noOp]))).toMatchObject({
    summary: 'File content unchanged.',
    fileNotice: 'File content unchanged.',
    fileAction: 'Write',
  });
  const noOpApp = render(<InkExecution execution={noOp} snapshot={snapshot([noOp])} />);
  try {
    expect(noOpApp.lastFrame()).toContain('File content unchanged.');
    expect(noOpApp.lastFrame()).toContain('Write');
    expect(noOpApp.lastFrame()).not.toContain('(content unchanged)');
    expect(noOpApp.lastFrame()).not.toContain('"baseline"');
    expect(noOpApp.lastFrame()).not.toContain('Workspace file changed.');
  } finally {
    noOpApp.unmount();
  }
  for (const invalid of [
    { ...noOp, originStoreId: 'foreign' },
    { ...noOp, status: 'outcome_unknown' as const },
    { ...noOp, toolInput: { path: 'other.txt', base: after } },
    { ...noOp, toolInput: { path: 'original.txt', base: null } },
    {
      ...noOp,
      result: {
        ...(noOp.result as object),
        content: JSON.stringify({ path: 'original.txt', baseline: { ...after, inode: '99' } }),
      },
    },
  ]) {
    expect(projectInkTool(invalid, snapshot([invalid])).fileNotice).toBeUndefined();
  }
});

test('qualified file previews reach the original diff renderer, with bounded UTF-8 and explicit truncation', () => {
  const before = { hash: 'a'.repeat(64), size: 10, device: '1', inode: '2' };
  const after = { ...before, hash: 'b'.repeat(64), size: 14 };
  const text = 'Added 1 lines, removed 1 lines\n 1 -old value\n 1 +新的🙂 value\n';
  const source = execution('edit', {
    definitionId: 'builtin.files/files.edit',
    definitionVersion: '2',
    toolInput: { path: 'original.ts', base: before },
    result: {
      outcome: 'succeeded',
      content: JSON.stringify({ path: 'original.ts', baseline: after }),
      details: {
        fileChange: {
          version: 1,
          format: 'line_diff',
          path: 'original.ts',
          before,
          after,
          text,
          truncated: true,
        },
      },
    },
  });
  const facts = snapshot([source]);
  expect(projectInkTool(source, facts)).toMatchObject({
    name: 'edit_file',
    summary: text,
    fileNotice: 'Workspace file changed.',
    filePreviewTruncated: true,
  });
  const app = render(<InkExecution execution={source} snapshot={facts} columns={80} />);
  try {
    expect(app.lastFrame()).toContain('Added 1 lines, removed 1 lines');
    expect(app.lastFrame()).toContain('-old value');
    expect(app.lastFrame()).toContain('+新的🙂 value');
    expect(app.lastFrame()).toContain('File change preview truncated');
    expect(app.lastFrame()).not.toContain('"baseline"');
  } finally {
    app.unmount();
  }
  const result = source.result as { details: { fileChange: Record<string, unknown> } };
  for (const change of [
    { ...result.details.fileChange, text: '\ud800' },
    { ...result.details.fileChange, text: '界'.repeat(21846) },
    { ...result.details.fileChange, path: 'foreign.ts' },
    { ...result.details.fileChange, before: { ...before, hash: 'c'.repeat(64) } },
    { ...result.details.fileChange, after: { ...after, inode: '99' } },
  ]) {
    const invalid = {
      ...source,
      result: { ...(source.result as object), details: { fileChange: change } },
    };
    const projected = projectInkTool(invalid, snapshot([invalid]));
    expect(projected.fileNotice).toBeUndefined();
    expect(projected.filePreviewTruncated).toBeUndefined();
  }
});

test('long child Markdown stays rendered through scrolling and width changes, independently of Tool records', async () => {
  const carrier = execution('carrier', {
    kind: 'job',
    childSessionId: 'child',
    parentExecutionId: 'task',
  });
  const body = [
    '```ts',
    ...Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`),
    '```',
    '',
    '| 名称 | Value |',
    '| --- | --- |',
    '| 尾部 | **COMPLETE_CHILD_TAIL** |',
  ].join('\n');
  const tool = execution('child-tool', {
    sessionId: 'child',
    toolInput: { path: 'original.ts' },
    result: { content: 'actual child Tool output' },
  });
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
    view: view('child', { executions: [tool] }),
    messages: [message('child-message', '1', { sessionId: 'child', content: body })],
    modelOutputs: new Map(),
  };
  let refreshes = 0;
  const app = render(
    <TuiChildSessionPanel child={child} onBack={() => {}} onRefresh={() => refreshes++} />,
  );
  const tick = () => Bun.sleep(25);
  try {
    Object.defineProperty(app.stdout, 'columns', { configurable: true, get: () => 60 });
    app.stdout.emit('resize');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('┌─ ts');
    expect(app.lastFrame()).toContain('const line0 = 0;');
    expect(app.lastFrame()).not.toContain('```ts');
    app.stdin.write('\u001b[F');
    await tick();
    expect(app.lastFrame()).toContain('COMPLETE_CHILD_TAIL');
    expect(app.lastFrame()).toContain('┼');
    expect(app.lastFrame()).not.toContain('**COMPLETE_CHILD_TAIL**');
    Object.defineProperty(app.stdout, 'columns', { configurable: true, get: () => 46 });
    app.stdout.emit('resize');
    await tick();
    app.stdin.write('\u001b[H');
    await tick();
    expect(app.lastFrame()).toContain('┌─ ts');
    app.stdin.write('\u001b[B');
    await tick();
    expect(app.lastFrame()).not.toContain('```');
    app.stdin.write('\t');
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('Read');
    expect(app.lastFrame()).toContain('actual child Tool output');
    app.stdin.write('r');
    await tick();
    expect(refreshes).toBe(1);
    expect(child.messages[0]!.content).toBe(body);
    expect(child.target.sessionId).toBe('parent');
    expect(child.view.session.nextSeq).toBe('30');
  } finally {
    app.unmount();
  }
});
