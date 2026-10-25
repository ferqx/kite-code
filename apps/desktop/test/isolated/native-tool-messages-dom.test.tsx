import { expect, test } from 'bun:test';
import type { JobDefinition, ToolContext } from '@kite-ai/agent/extensions';
import { createShellExtension } from '@kite-ai/agent/shell';
import type { AgentClient, Execution, Message } from '@kite-ai/client';
import { DesktopDiagnosticsProvider, SessionPage, ToolActivity } from '@kite-ai/ui/desktop';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createModelToolSurface } from '../../../../packages/agent/src/model-tools';
import { NativeToolMessages } from '../../electron/tool-messages';
import type { NativeBridge, NativeRequest, NativeSelection } from '../../src/native-bridge';
import {
  desktopToolMessage,
  desktopToolPresentation,
  groupNativeToolMessages,
  liveToolMessages,
  NativeLiveToolMessage,
  NativeToolMessage,
  useNativeToolMessages,
} from '../../src/native-tool-messages';
import { desktopTranscript } from '../../src/native-transcript';
import type { NativeToolMessageFact, NativeToolMessagePage } from '../../src/tool-messages-bridge';
import { prepareDesktopDom } from '../native-page-dom.fixture';

test('collaboration tool labels use exact new definitions and versions without inferring an Agent outcome', () => {
  expect(
    desktopToolPresentation({ definitionId: 'task.spawn', definitionVersion: '1' }),
  ).toMatchObject({ toolName: 'spawn_agent', title: '创建子 Agent' });
  expect(
    desktopToolPresentation({ definitionId: 'task.follow_up', definitionVersion: '1' }),
  ).toMatchObject({ toolName: 'follow_up_agent', title: '继续子 Agent' });
  expect(
    desktopToolPresentation({ definitionId: 'task.spawn', definitionVersion: '9' }).toolName,
  ).toBeUndefined();
  expect(
    desktopToolMessage(
      { definitionId: 'task.spawn', definitionVersion: '1', status: 'succeeded' },
      'spawn',
      'accepted',
    ),
  ).toMatchObject({ status: 'completed', title: '创建子 Agent' });
});

test('a live long command survives queued approvals, View refresh and receipt-first takeover without borrowing execution state', async () => {
  const f = fixture(),
    command = `printf start\n${'雪🙂'.repeat(3000)}\nprintf end`;
  const run = {
    id: 'live-run',
    originCommandId: 'start-live',
    originStoreId: 'store',
    sessionId: 's',
    isActive: true,
    status: 'running' as const,
    createdAt: 0,
    finishedAt: null,
    reason: null,
  };
  let execution: Execution = {
    id: 'live-command',
    originStoreId: 'store',
    sessionId: 's',
    runId: run.id,
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    status: 'planned',
    toolCallId: 'live-call',
    toolInput: { key: 'original', command },
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
  };
  let selected = { ...selection(), runs: [run], executions: [execution] };
  const history = new Map<string, Message>([
    [
      'model',
      {
        id: 'model',
        seq: '1',
        role: 'assistant',
        status: 'incomplete',
        firstOutput: 'tool_calls',
        sessionId: 's',
        runId: run.id,
        content: '',
        toolCalls: [],
      },
    ],
  ]);
  let gets = 0,
    releaseCommand!: () => void,
    releaseReceipt!: () => void;
  let commandSignal: AbortSignal | undefined;
  const commandGate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const receiptGate = new Promise<void>((resolve) => {
    releaseReceipt = resolve;
  });
  const client = {
    verifyConnection: async () => {},
    getExecution: async (_id: string, options?: { signal?: AbortSignal }) => {
      gets++;
      if (gets === 2) {
        commandSignal = options?.signal;
        await commandGate;
      }
      if (history.has('receipt')) await receiptGate;
      return execution;
    },
  } as unknown as AgentClient;
  const scope = {
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const manager = new NativeToolMessages(
    client,
    () => scope,
    () => history,
    () => selected.executions,
  );
  const requests: NativeRequest[] = [];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method === 'toolMessages.list') return manager.list(request);
      if (request.method === 'toolMessages.close') manager.close(request.readId);
      return null;
    },
  } as NativeBridge;
  let projected: ReturnType<typeof groupNativeToolMessages> = [];
  function Harness({ selected, messages }: { selected: NativeSelection; messages: Message[] }) {
    const facts = useNativeToolMessages({
      bridge,
      generation: 1,
      selection: selected,
      historyEpoch: 0,
      messages,
      observationRevision: selected.viewGeneration,
    });
    const transcript = desktopTranscript({
      messages,
      runs: selected.runs,
      tools: facts.entries,
      executions: selected.executions,
      storeId: 'store',
      sessionId: 's',
    });
    projected = groupNativeToolMessages([
      ...transcript.messages,
      ...liveToolMessages(selected, messages, false, facts.entries).map((item) => item.message),
    ]);
    return (
      <SessionPage
        workspaces={[]}
        sessionLabel="live Shell"
        readingKey="live-command"
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={projected}
      />
    );
  }
  const render = () =>
    act(async () =>
      f.root.render(<Harness selected={selected} messages={[...history.values()]} />),
    );
  try {
    await render();
    expect(gets).toBe(2);
    expect(projected.find((model) => model.role === 'tool')?.shell?.commandPreview).toContain(
      'printf start',
    );
    const aggregate = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    await act(async () => aggregate.click());
    const row = f.host.querySelector<HTMLButtonElement>(
      '.tool-activity-steps button.tool-activity-summary',
    )!;
    await act(async () => row.click());
    const card = f.host.querySelector('.shell-output'),
      viewport = f.host.querySelector('.shell-output-viewport');
    const phases: Execution['authorization'][] = [
      {
        dispatched: false,
        check: {
          executionId: 'check',
          status: 'running',
          decision: 'unavailable',
          reason: 'checking',
          requireApproval: true,
        },
      },
      {
        dispatched: false,
        human: {
          interactionId: 'approval',
          state: 'pending',
          revision: '1',
          acceptedDecisionRevision: null,
          accepted: false,
          decision: null,
        },
      },
      { dispatched: true },
    ];
    for (const [index, authorization] of phases.entries()) {
      execution = { ...execution, status: index === 2 ? 'running' : 'planned', authorization };
      selected = {
        ...selected,
        viewGeneration: index + 2,
        viewLoading: index === 1,
        executions: [execution],
      };
      await render();
      expect(gets).toBe(2);
      expect(commandSignal?.aborted).toBe(false);
      expect(f.host.querySelector('.shell-output') === card).toBe(true);
    }
    selected = { ...selected, viewLoading: false };
    await act(async () => releaseCommand());
    await render();
    expect(gets).toBe(3);
    expect(projected.find((model) => model.role === 'tool')?.shell?.command).toBe(command);
    expect(projected.find((model) => model.role === 'tool')?.status).toBe('running');
    expect(projected.find((model) => model.role === 'tool')?.approval).toBeUndefined();
    expect(f.host.querySelector('.shell-output-viewport') === viewport).toBe(true);
    const raw = JSON.stringify({
      ref: {
        key: 'original',
        extensionId: 'builtin.shell',
        originStoreId: 'store',
        sessionId: 's',
        commandId: 'start',
        executionId: 'job',
      },
      execution: {
        id: 'job',
        sessionId: 's',
        originStoreId: 'store',
        kind: 'job',
        definitionId: 'shell.command',
        definitionVersion: '1',
        status: 'succeeded',
        result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
      },
      stdout: 'done\n',
      stderr: '',
      stdoutBytes: '5',
      stderrBytes: '0',
      droppedBytes: '0',
      truncated: false,
      timedOut: false,
    });
    execution = {
      ...execution,
      status: 'succeeded',
      resultRevision: '1',
      result: { outcome: 'succeeded', content: raw, details: JSON.parse(raw) },
    };
    selected = { ...selected, executions: [execution] };
    history.set('receipt', {
      id: 'receipt',
      seq: '2',
      role: 'tool',
      status: 'complete',
      sessionId: 's',
      runId: run.id,
      toolCallId: 'live-call',
      sourceIds: [execution.id],
      content: raw,
    });
    await render();
    const pending = projected.find((model) => model.id === 'receipt')!;
    expect(pending.shell?.command).toBe(command);
    expect(pending.shell?.jobStatus).toBeUndefined();
    expect(pending.status).toBeUndefined();
    expect(pending.approval).toBeUndefined();
    expect(f.host.querySelector('.tool-activity-steps button.tool-activity-summary') === row).toBe(
      true,
    );
    expect(row.getAttribute('aria-expanded')).toBe('true');
    await act(async () => releaseReceipt());
    await render();
    expect(projected.find((model) => model.id === 'receipt')?.shell).toMatchObject({
      command,
      jobStatus: 'succeeded',
      stdout: 'done\n',
    });
    expect(f.host.querySelector('.shell-output') === card).toBe(true);
    expect(f.host.querySelector('.shell-output-viewport') === viewport).toBe(true);
    expect(
      requests.filter((request) => request.method === 'toolMessages.list' && request.executionIds),
    ).toHaveLength(3);
  } finally {
    releaseCommand();
    releaseReceipt();
    manager.release();
    await f.close();
  }
});

function ShellMetadataHarness({
  bridge,
  messages,
  selected = selection(),
}: {
  bridge: NativeBridge;
  messages: Message[];
  selected?: NativeSelection;
}) {
  const facts = useNativeToolMessages({
    bridge,
    generation: 1,
    selection: selected,
    historyEpoch: 0,
    messages,
    observationRevision: 0,
  });
  return (
    <>
      <output data-testid="shell-facts">
        {JSON.stringify({
          loading: facts.loading,
          error: facts.error,
          entries: facts.entries,
          pending: [...facts.pendingMessageIds],
        })}
      </output>
      {messages
        .filter((value) => value.role === 'tool')
        .map((value) => {
          const fact = facts.entries.find((entry) => entry.messageId === value.id);
          return (
            <NativeToolMessage
              key={value.id}
              message={
                fact
                  ? desktopToolMessage(fact, value.id, value.content)
                  : { id: value.id, role: 'tool', text: value.content, settled: true }
              }
            />
          );
        })}
      <button type="button" onClick={facts.retry}>
        retry
      </button>
    </>
  );
}

test('the exact saved Shell request is readable before Model history completes and visible conflicts still revoke its presentation', async () => {
  const f = fixture(),
    command = 'printf first\nprintf second\n',
    stdout = 'first\nsecond\n';
  const jobDefinition: JobDefinition = {
    id: 'shell.command',
    version: '1',
    description: 'unused registration',
    inputSchema: { type: 'object' },
    async start() {
      throw Error('no_process_start');
    },
    observe() {
      throw Error('no_process_observe');
    },
    async cancel() {
      throw Error('no_process_cancel');
    },
    async dispose() {},
  };
  const shell = createShellExtension({ job: jobDefinition });
  const surface = createModelToolSurface(
    {
      modelId: 'fixture',
      requestId: 'model-request',
      messages: [],
      tools: shell.tools!.map((tool) => ({
        id: tool.id,
        definitionVersion: tool.version,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
    new Map(shell.tools!.map((tool) => [tool.id, tool])),
  );
  const call = surface.decode({
    id: 'actual-call',
    name: 'shell_execute',
    arguments: JSON.stringify({ key: 'exact-command', command }),
  });
  expect(call.name).toBe('shell.execute');
  const ref = {
    key: 'exact-command',
    extensionId: 'builtin.shell',
    sessionId: 's',
    originStoreId: 'store',
    commandId: 'job-start',
    executionId: 'actual-job',
  };
  const job = {
    id: ref.executionId,
    kind: 'job',
    definitionId: 'shell.command',
    definitionVersion: '1',
    sessionId: 's',
    originStoreId: 'store',
    status: 'succeeded',
    result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
  };
  const result = await shell
    .tools!.find((tool) => tool.id === 'shell.execute')!
    .execute(JSON.parse(call.arguments), {
      signal: new AbortController().signal,
      records: { get: async () => null, write: async () => {} },
      operations: {
        ensure: async () => ref,
        wait: async () => job,
        readOutput: async () => ({
          highWaterSeq: '1',
          items: [
            {
              executionId: ref.executionId,
              seq: '1',
              throughSeq: '1',
              stream: 'stdout',
              content: stdout,
              droppedBytes: null,
            },
          ],
        }),
      },
    } as unknown as ToolContext);
  const declaration: Message = {
    id: 'actual-model',
    seq: '10',
    role: 'assistant',
    status: 'incomplete',
    sessionId: 's',
    runId: 'actual-run',
    content: '',
    firstOutput: 'tool_calls',
    toolCalls: [],
  };
  const receipt: Message = {
    id: 'actual-receipt',
    seq: '20',
    role: 'tool',
    status: 'complete',
    sessionId: 's',
    runId: 'actual-run',
    content: result.content,
    toolCallId: call.id,
    sourceIds: ['actual-tool'],
  };
  const sibling: Message = {
    ...receipt,
    id: 'file-receipt',
    seq: '21',
    toolCallId: undefined,
    sourceIds: ['file-tool'],
    content: 'file content',
  };
  const execution: Execution = {
    id: 'actual-tool',
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    sessionId: 's',
    runId: 'actual-run',
    originStoreId: 'store',
    status: 'succeeded',
    result: JSON.parse(JSON.stringify(result)) as Execution['result'],
    resultRevision: '1',
    toolCallId: call.id,
    toolInput: JSON.parse(call.arguments),
    cancelRequestedAt: null,
  };
  const fileExecution: Execution = {
    ...execution,
    id: 'file-tool',
    definitionId: 'files.read',
    definitionVersion: '5',
    toolCallId: undefined,
    result: { outcome: 'succeeded', content: sibling.content },
  };
  const history = new Map([declaration, receipt, sibling].map((message) => [message.id, message]));
  const gets: string[] = [],
    requests: NativeRequest[] = [];
  let fail = false;
  let gate: Promise<void> | undefined, release!: () => void;
  const client = {
    verifyConnection: async () => {},
    getExecution: async (id: string) => {
      gets.push(id);
      if (id === execution.id) await gate;
      if (fail && id === execution.id) throw Error('read_unavailable');
      return id === execution.id ? execution : fileExecution;
    },
  } as unknown as AgentClient;
  const scope = {
    generation: 1,
    viewSelection: 2,
    historyEpoch: 0,
    storeId: 'store',
    sessionId: 's',
    workspaceId: 'w',
  };
  const manager = new NativeToolMessages(
    client,
    () => scope,
    () => history,
  );
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method === 'toolMessages.list') return manager.list(request);
      if (request.method === 'toolMessages.close') manager.close(request.readId);
      return null;
    },
  } as NativeBridge;
  const render = () =>
    act(async () =>
      f.root.render(<ShellMetadataHarness bridge={bridge} messages={[...history.values()]} />),
    );
  const facts = () =>
    JSON.parse(f.host.querySelector('[data-testid="shell-facts"]')!.textContent!) as {
      entries: NativeToolMessageFact[];
      pending: string[];
      error?: string;
    };
  try {
    await render();
    expect(gets).toEqual(['actual-tool', 'file-tool']);
    expect(facts().entries.find((fact) => fact.messageId === receipt.id)?.shellInput?.command).toBe(
      command,
    );
    expect(facts().pending).toEqual([]);
    const item = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    await act(async () => item.click());
    const card = f.host.querySelector('.shell-output')!;
    expect(card.querySelector('.shell-console-output')?.textContent).toBe(stdout);
    history.set(declaration.id, { ...declaration, status: 'complete', toolCalls: [call] });
    await render();
    expect(gets).toEqual(['actual-tool', 'file-tool']);
    const fact = facts().entries.find((fact) => fact.messageId === receipt.id)!;
    expect(fact.shellInput?.command).toBe(command);
    expect(fact.shellResultVerified).toBe(true);
    expect(f.host.querySelector('.shell-output') === card).toBe(true);
    expect(item.getAttribute('aria-expanded')).toBe('true');
    expect(card.querySelector('.shell-command-text')?.textContent).toBe(command);
    expect(card.querySelector('.shell-console-output')?.textContent).toBe(stdout);
    expect(card.textContent).not.toContain('"execution"');
    const unrelated = {
      ...declaration,
      id: 'unrelated-model',
      seq: '30',
      content: 'new prose',
      status: 'incomplete' as const,
    };
    history.set(unrelated.id, unrelated);
    await render();
    history.set(unrelated.id, { ...unrelated, status: 'complete' });
    await render();
    expect(gets).toEqual(['actual-tool', 'file-tool']);
    expect(requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(1);
    // An earlier streamed Model may later expose a duplicate original call ID.
    const duplicate = { ...declaration, id: 'older-model', seq: '9' };
    history.set(duplicate.id, duplicate);
    await render();
    expect(gets).toHaveLength(2);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    history.set(duplicate.id, { ...duplicate, status: 'complete', toolCalls: [call] });
    await render();
    expect(gets).toEqual(['actual-tool', 'file-tool', 'actual-tool']);
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
    ).toBeUndefined();
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellResultVerified,
    ).toBeUndefined();
    expect(facts().pending).toEqual([]);
    expect(f.host.querySelector('.shell-output') === card).toBe(true);
    expect(item.getAttribute('aria-expanded')).toBe('true');
    await act(async () => release());
    gate = undefined;
    expect(facts().error).toBeUndefined();
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
    ).toBeUndefined();
    expect(card.textContent).toContain(result.content);
    history.delete(duplicate.id);
    await render();
    expect(gets).toHaveLength(4);
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
    ).toBe(command);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    history.set(duplicate.id, { ...duplicate, status: 'complete', toolCalls: [call] });
    await render();
    expect(gets).toHaveLength(5);
    fail = true;
    await act(async () => release());
    gate = undefined;
    expect(facts().error).toBeDefined();
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
    ).toBeUndefined();
    expect(facts().entries.some((entry) => entry.messageId === sibling.id)).toBe(true);
    expect(gets.filter((id) => id === fileExecution.id)).toHaveLength(1);
    history.delete(duplicate.id);
    await render();
    expect(gets).toHaveLength(5); // Failed reads require the existing explicit retry.
    expect(facts().error).toBeDefined();
    fail = false;
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    expect(facts().error).toBeUndefined();
    expect(
      facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
    ).toBe(command);
    // A duplicate streamed or unreadable call stays disqualifying after Main replies.
    const recoveredItem = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    if (recoveredItem.getAttribute('aria-expanded') !== 'true')
      await act(async () => recoveredItem.click());
    const recoveredCard = f.host.querySelector('.shell-output');
    expect(recoveredCard).not.toBeNull();
    for (const state of [
      { status: 'incomplete' as const },
      { status: 'complete' as const, contentFormat: 'unsupported' as const },
    ]) {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      history.set(duplicate.id, { ...duplicate, ...state, toolCalls: [call] });
      await render();
      expect(
        facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
      ).toBeUndefined();
      await act(async () => release());
      gate = undefined;
      expect(facts().error).toBeUndefined();
      expect(
        facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
      ).toBeUndefined();
      expect(f.host.querySelector('.shell-output') === recoveredCard).toBe(true);
      expect(recoveredItem.getAttribute('aria-expanded')).toBe('true');
      history.delete(duplicate.id);
      await render();
      expect(
        facts().entries.find((entry) => entry.messageId === receipt.id)?.shellInput?.command,
      ).toBe(command);
    }
    // No original source and future versions remain readable without busy retries.
    history.delete(declaration.id);
    history.delete(unrelated.id);
    await render();
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    const noSourceReads = gets.length;
    expect(facts().pending).toEqual([]);
    for (let index = 0; index < 3; index++) {
      history.set('foreign-model', {
        ...declaration,
        id: 'foreign-model',
        runId: 'other-run',
        status: 'complete',
        content: String(index),
        toolCalls: [call],
      });
      await render();
    }
    expect(gets).toHaveLength(noSourceReads);
    expect(f.host.querySelector('.shell-console-output')?.textContent).toBe(stdout);
    execution.definitionVersion = '9';
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    const futureReads = gets.length;
    history.set(declaration.id, { ...declaration, status: 'complete', toolCalls: [call] });
    await render();
    expect(gets).toHaveLength(futureReads);
    expect(facts().pending).toEqual([]);
    expect(facts().entries.find((entry) => entry.messageId === receipt.id)?.definitionVersion).toBe(
      '9',
    );
    expect(requests.some((request) => request.method === 'toolMessages.close')).toBe(true);
  } finally {
    fail = false;
    manager.release();
    await f.close();
  }
});

test('Shell command continuations retain verified siblings and the same disclosure, then publish only the full original command', async () => {
  const f = fixture(),
    command = `echo begin\n${'雪🙂'.repeat(1200)}\necho end`;
  const values = [
    message('command', 'original Shell receipt'),
    message('sibling', 'original file receipt'),
  ];
  let release!: (page: NativeToolMessagePage) => void;
  const requests: NativeRequest[] = [];
  let continuation: Extract<NativeRequest, { method: 'toolMessages.list' }> | undefined;
  const makePage = (request: Extract<NativeRequest, { method: 'toolMessages.list' }>) => {
    const page = pageFor(request, 's');
    page.entries = request.messageIds.map(
      (id): NativeToolMessageFact =>
        id === 'sibling'
          ? {
              messageId: id,
              executionId: `e-${id}`,
              definitionId: 'files.read',
              definitionVersion: '5',
              status: 'succeeded',
              resultRevision: '1',
              target: '/workspace/readme.md',
            }
          : {
              messageId: id,
              executionId: `e-${id}`,
              definitionId: 'shell.execute',
              definitionVersion: '1',
              status: 'succeeded',
              resultRevision: '1',
              shellInput: request.commandOffsets
                ? {
                    operation: 'execute',
                    shellId: 'original',
                    command: command.slice(1000),
                    commandOffset: 1000,
                    commandNextOffset: null,
                  }
                : {
                    operation: 'execute',
                    shellId: 'original',
                    command: command.slice(0, 1000),
                    commandOffset: 0,
                    commandNextOffset: 1000,
                  },
            },
    );
    return page;
  };
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.list') return null;
      if (!request.commandOffsets) return makePage(request);
      continuation = request;
      return new Promise<NativeToolMessagePage>((resolve) => {
        release = resolve;
      });
    },
  } as NativeBridge;
  const facts = () =>
    JSON.parse(f.host.querySelector('[data-testid="shell-facts"]')!.textContent!) as {
      loading: boolean;
      entries: NativeToolMessageFact[];
      error?: string;
      pending: string[];
    };
  try {
    await act(async () =>
      f.root.render(<ShellMetadataHarness bridge={bridge} messages={values} />),
    );
    expect(continuation?.messageIds).toEqual(['command']);
    expect(continuation?.commandOffsets).toEqual({ command: 1000 });
    expect(facts().loading).toBe(true);
    expect(facts().pending).toEqual(['command']);
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBeUndefined();
    expect(facts().entries.find((entry) => entry.messageId === 'sibling')?.target).toBe(
      '/workspace/readme.md',
    );
    const disclosure = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    await act(async () => release(makePage(continuation!)));
    expect(facts().loading).toBe(false);
    expect(facts().pending).toEqual([]);
    expect(facts().error).toBeUndefined();
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBe(command);
    expect(f.host.querySelector('button.tool-activity-summary')).toBe(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.shell-command-text')?.textContent).toContain(command);
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain(
      'original Shell receipt',
    );
    expect(requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('bad Shell continuation offsets retain checked metadata and raw results; retry and selection release never reuse partial commands', async () => {
  const f = fixture(),
    values = [message('command', 'original raw result'), message('sibling', 'file record')];
  const requests: NativeRequest[] = [];
  let mode: 'bad-initial' | 'bad' | 'retry' | 'late' = 'bad-initial';
  let late!: (page: NativeToolMessagePage) => void;
  let lateRequest: Extract<NativeRequest, { method: 'toolMessages.list' }> | undefined;
  const makePage = (
    request: Extract<NativeRequest, { method: 'toolMessages.list' }>,
    sessionId = 's',
  ) => {
    const page = pageFor(request, sessionId);
    page.entries = page.entries.map((entry) =>
      entry.messageId === 'command'
        ? {
            ...entry,
            definitionId: 'shell.execute',
            shellInput: {
              operation: 'execute',
              shellId: 'original',
              command: request.commandOffsets ? 'end' : 'begin',
              commandOffset: request.commandOffsets
                ? mode === 'bad'
                  ? 999
                  : 5
                : mode === 'bad-initial'
                  ? 999
                  : 0,
              commandNextOffset: request.commandOffsets ? null : 5,
            },
          }
        : { ...entry, definitionId: 'files.read', definitionVersion: '5', target: 'original.md' },
    );
    return page;
  };
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.list') return null;
      if (mode === 'late' && request.commandOffsets) {
        lateRequest = request;
        return new Promise<NativeToolMessagePage>((resolve) => {
          late = resolve;
        });
      }
      return makePage(request, request.viewSelection === 3 ? 'later' : 's');
    },
  } as NativeBridge;
  const facts = () =>
    JSON.parse(f.host.querySelector('[data-testid="shell-facts"]')!.textContent!) as {
      loading: boolean;
      entries: NativeToolMessageFact[];
      error?: string;
    };
  const render = (selected = selection(), messages = values) =>
    act(async () =>
      f.root.render(
        <ShellMetadataHarness bridge={bridge} messages={messages} selected={selected} />,
      ),
    );
  try {
    await render();
    expect(facts().error).toBeDefined();
    expect(facts().loading).toBe(false);
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBeUndefined();
    expect(facts().entries.find((entry) => entry.messageId === 'sibling')?.target).toBe(
      'original.md',
    );
    const button = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    await act(async () => button.click());
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain(values[0]!.content);
    mode = 'bad';
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    expect(facts().error).toBeDefined();
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBeUndefined();
    expect(facts().entries.find((entry) => entry.messageId === 'sibling')?.target).toBe(
      'original.md',
    );
    mode = 'retry';
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    expect(facts().error).toBeUndefined();
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBe('beginend');
    mode = 'late';
    await act(async () =>
      [...f.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((node) => node.textContent === 'retry')!
        .click(),
    );
    expect(lateRequest).toBeDefined();
    expect(facts().loading).toBe(true);
    mode = 'retry';
    const changed = values.map((value) => ({
      ...value,
      sessionId: 'later',
      content: 'new original record',
    }));
    await render(selection('later', 3), changed);
    expect(requests).toContainEqual({
      method: 'toolMessages.close',
      generation: 1,
      readId: lateRequest!.readId,
    });
    await act(async () => late(makePage(lateRequest!)));
    expect(
      facts().entries.find((entry) => entry.messageId === 'command')?.shellInput?.command,
    ).toBe('beginend');
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain('new original record');
    expect(f.host.querySelector('.shell-output pre')?.textContent).not.toContain(
      'original raw result',
    );
  } finally {
    await f.close();
  }
});

test('the exact Native Tool keeps its reading identity and open Shell card from live carrier through unverified and verified receipts', async () => {
  const f = fixture();
  const run = {
    id: 'reading-run',
    originStoreId: 'store',
    sessionId: 's',
    isActive: true,
    status: 'running' as const,
    createdAt: 0,
    finishedAt: null,
    reason: null,
  };
  const execution: Execution = {
    id: 'reading-tool',
    originStoreId: 'store',
    sessionId: 's',
    runId: run.id,
    kind: 'tool',
    definitionId: 'shell.execute',
    definitionVersion: '1',
    status: 'running',
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
  };
  const selected = { ...selection(), runs: [run], executions: [execution] };
  const live = liveToolMessages(selected, [] as Message[])[0]!.message;
  const ref = {
    extensionId: 'builtin.shell',
    key: 'original-command',
    sessionId: 's',
    originStoreId: 'store',
    commandId: 'original',
    executionId: 'original-job',
  };
  const command = 'printf first\nprintf second\n';
  const raw = JSON.stringify({
    ref,
    execution: {
      id: ref.executionId,
      sessionId: 's',
      originStoreId: 'store',
      kind: 'job',
      definitionId: 'shell.command',
      definitionVersion: '1',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'Shell succeeded', details: { exitCode: 0 } },
    },
    stdout: 'final output\n',
    stderr: '',
    stdoutBytes: '13',
    stderrBytes: '0',
    droppedBytes: '0',
    truncated: false,
    timedOut: false,
  });
  const receipt: Message = {
    id: 'reading-receipt',
    seq: '2',
    role: 'tool',
    status: 'complete',
    runId: run.id,
    sessionId: 's',
    content: raw,
    sourceIds: [execution.id],
  };
  const declaration: Message = {
    id: 'reading-model',
    seq: '1',
    role: 'assistant',
    status: 'complete',
    sessionId: 's',
    runId: run.id,
    content: '',
    firstOutput: 'tool_calls',
  };
  const fact: NativeToolMessageFact = {
    messageId: receipt.id,
    executionId: execution.id,
    definitionId: 'shell.execute',
    definitionVersion: '1',
    status: 'succeeded',
    resultRevision: '1',
    shellInput: {
      operation: 'execute',
      shellId: ref.key,
      command,
      commandOffset: 0,
      commandNextOffset: null,
    },
    shellResultVerified: true,
  };
  const projected = (tools: NativeToolMessageFact[]) =>
    groupNativeToolMessages(
      desktopTranscript({
        messages: [declaration, receipt],
        runs: [run],
        tools,
        executions: [execution],
        storeId: 'store',
        sessionId: 's',
      }).messages,
    );
  const render = (models: ReturnType<typeof projected>) =>
    act(async () =>
      f.root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="Native Shell identity"
          readingKey="native-shell-identity"
          loading={false}
          connected
          connectionLabel="local"
          actions={{}}
          messages={models}
        />,
      ),
    );
  try {
    const initial = groupNativeToolMessages([live]);
    await render(initial);
    const aggregate = f.host.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    await act(async () => aggregate.click());
    const item = f.host.querySelector<HTMLButtonElement>(
      '.tool-activity-steps button.tool-activity-summary',
    )!;
    await act(async () => item.click());
    const shellCard = f.host.querySelector('.shell-output')!;
    expect(item.getAttribute('aria-expanded')).toBe('true');
    const pending = projected([]),
      pendingTool = pending.find((model) => model.id === receipt.id)!;
    expect(pendingTool.id).not.toBe(live.id);
    expect(pendingTool.presentationKey).toBe(live.presentationKey);
    expect(pendingTool.shell).toEqual({ operation: 'execute' });
    expect(pendingTool.status).toBeUndefined();
    expect(pendingTool.presentationGroupId).toBe(initial[0]!.presentationGroupId);
    await render(pending);
    expect(f.host.querySelector('.tool-activity-steps button.tool-activity-summary') === item).toBe(
      true,
    );
    expect(item.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.shell-output') === shellCard).toBe(true);
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain(raw);
    await render(projected([fact]));
    expect(f.host.querySelector('.tool-activity-steps button.tool-activity-summary') === item).toBe(
      true,
    );
    expect(item.getAttribute('aria-expanded')).toBe('true');
    expect(f.host.querySelector('.shell-output') === shellCard).toBe(true);
    expect(f.host.querySelector('.shell-command-text')?.textContent).toBe(command);
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain('final output\n');
    expect(f.host.querySelectorAll('.shell-output')).toHaveLength(1);
    expect(projected([fact]).find((model) => model.id === receipt.id)?.id).toBe(receipt.id);
    const scoped = desktopTranscript({
      messages: [
        {
          ...receipt,
          originMessage: {
            storeId: 'other-store',
            sessionId: 's',
            runId: run.id,
            messageId: 'origin',
          },
        },
      ],
      runs: [run],
      tools: [],
      storeId: 'store',
      sessionId: 's',
    }).messages[0]!;
    expect(scoped.presentationKey).toBeUndefined();
  } finally {
    await f.close();
  }
});

function fixture() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const layout = prepareDesktopDom(dom),
    previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = dom.window.document.getElementById('root')!,
    root = createRoot(host);
  return {
    dom,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      layout();
      Object.assign(globalThis, previous);
    },
  };
}
const selection = (id = 's', viewSelection = 2) =>
  ({
    storeId: 'store',
    viewSelection,
    viewGeneration: 1,
    session: { id, workspaceId: 'w' },
    runs: [],
    executions: [],
  }) as unknown as NativeSelection;
const message = (id: string, content: string, sessionId = 's'): Message => ({
  id,
  seq: '1',
  role: 'tool',
  status: 'complete',
  runId: 'run',
  sessionId,
  content,
  sourceIds: [`e-${id}`],
});
function Harness({
  bridge,
  selected,
  messages,
  observationRevision = 0,
}: {
  bridge: NativeBridge;
  selected: NativeSelection;
  messages: Message[];
  observationRevision?: number;
}) {
  const facts = useNativeToolMessages({
    bridge,
    generation: 1,
    selection: selected,
    historyEpoch: 0,
    messages,
    observationRevision,
  });
  return (
    <>
      <SessionPage
        workspaces={[]}
        sessionLabel="tools"
        readingKey={selected.session.id}
        loading={false}
        connected
        connectionLabel="local"
        actions={{}}
        messages={messages.map((value) => ({
          id: value.id,
          text: value.content,
          role: value.role,
          settled: true,
        }))}
        renderMessage={(model) => {
          const fact = facts.entries.find((entry) => entry.messageId === model.id);
          return fact ? (
            <NativeToolMessage message={desktopToolMessage(fact, model.id, model.text)} />
          ) : (
            <pre>{model.text}</pre>
          );
        }}
      />
      {facts.error && <p role="alert">{facts.error}</p>}
      <button type="button" onClick={facts.retry}>
        retry
      </button>
    </>
  );
}
const pageFor = (
  request: Extract<NativeRequest, { method: 'toolMessages.list' }>,
  sessionId: string,
): NativeToolMessagePage => ({
  kind: 'toolMessages.page',
  readId: request.readId,
  scope: {
    generation: 1,
    viewSelection: request.viewSelection,
    historyEpoch: request.historyEpoch,
    storeId: 'store',
    sessionId,
    workspaceId: 'w',
  },
  entries: request.messageIds.map((id) => ({
    messageId: id,
    executionId: `e-${id}`,
    definitionId: id === 'failed' ? 'files.read' : id === 'future' ? 'task' : 'shell.launch',
    definitionVersion: id === 'failed' ? '3' : id === 'future' ? '9' : '1',
    status: id === 'failed' ? 'failed' : id === 'future' ? 'outcome_unknown' : 'succeeded',
    resultRevision: '1',
    target: id === 'failed' ? 'missing.txt' : 'echo 雪🙂',
  })),
});

test('the retained tool UI shows exact failures and unverified Shell original results without claiming acceptance; unknown versions remain literal and escaped', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  const values = [
    message('shell', '{"accepted":true,"shellId":"job 雪🙂"}'),
    message('failed', 'file_not_found'),
    message('future', '<img src="https://invalid.example/leak"> original unknown result'),
  ];
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      return request.method === 'toolMessages.list' ? pageFor(request, 's') : null;
    },
  } as NativeBridge;
  const render = (messages = values) =>
    act(async () =>
      f.root.render(<Harness bridge={bridge} selected={selection()} messages={messages} />),
    );
  try {
    await render();
    const failed = [...f.host.querySelectorAll('.tool-activity')].find((node) =>
      node.textContent?.includes('missing.txt'),
    )!;
    expect(failed.textContent).toContain('读取missing.txt失败');
    expect(failed.querySelector('button.file-link')).toBeNull();
    expect(failed.querySelector('.tool-step-preview')).toBeNull();
    expect(f.host.textContent).not.toContain('file_not_found');
    const failedToggle = failed.querySelector<HTMLButtonElement>('button.tool-activity-summary')!;
    expect(failedToggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => failedToggle.click());
    expect(failed.textContent).toContain('file_not_found');
    await act(async () => failedToggle.click());
    expect(f.host.textContent).not.toContain('file_not_found');
    const shell = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('启动命令'),
    )!;
    expect(shell).toBeDefined();
    expect(f.host.textContent).not.toContain('已退出');
    await act(async () => shell.click());
    expect(f.host.querySelector('.shell-output pre')?.textContent).toContain(values[0]!.content);
    expect(f.host.querySelector('.shell-result')?.textContent).toBe('启动结果未提供');
    expect(f.host.querySelector('.shell-result-icon')).toBeNull();
    expect(f.host.textContent).not.toContain('已受理');
    const future = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('task · 9'),
    )!;
    await act(async () => future.click());
    expect(f.host.textContent).toContain('结果未知');
    expect(
      [...f.host.querySelectorAll('.tool-detail')].some(
        (entry) => entry.textContent === values[2]!.content,
      ),
    ).toBe(true);
    expect(f.host.querySelector('img')).toBeNull();
    await act(async () => shell.click());
    expect(
      [...f.host.querySelectorAll('.shell-output pre')].some((entry) =>
        entry.textContent?.includes(values[0]!.content),
      ),
    ).toBe(false);
    expect(requests.filter((request) => request.method === 'toolMessages.list')).toHaveLength(1);
    expect(
      requests.every((request) =>
        ['toolMessages.list', 'toolMessages.close'].includes(request.method),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('the directory row retains the verified workspace root target when the path was omitted', async () => {
  const f = fixture();
  try {
    await act(async () =>
      f.root.render(
        <NativeToolMessage
          message={desktopToolMessage(
            {
              definitionId: 'files.list',
              definitionVersion: '1',
              status: 'succeeded',
              target: '.',
            },
            'root-directory',
            '{"entries":[],"next":null}',
          )}
        />,
      ),
    );
    expect(f.host.textContent).toContain('列出目录.');
    expect(f.host.querySelector('.tool-activity-step.failed')).toBeNull();
  } finally {
    await f.close();
  }
});

test('all metadata batches are scope-bound, a late old-Session read cannot replace the later page, and changed original content is never shown with a stale status', async () => {
  const f = fixture(),
    requests: NativeRequest[] = [];
  let release!: (page: NativeToolMessagePage) => void,
    heldRequest: Extract<NativeRequest, { method: 'toolMessages.list' }> | undefined;
  const held = new Promise<NativeToolMessagePage>((resolve) => {
    release = resolve;
  });
  let hold = true;
  const bridge = {
    request: async (request: NativeRequest) => {
      requests.push(request);
      if (request.method !== 'toolMessages.list') return null;
      if (hold) {
        heldRequest = request;
        return held;
      }
      return pageFor(request, 'later');
    },
  } as NativeBridge;
  try {
    await act(async () =>
      f.root.render(
        <Harness
          bridge={bridge}
          selected={selection()}
          messages={[message('original', 'held old result')]}
        />,
      ),
    );
    expect(heldRequest).toBeDefined();
    hold = false;
    const values = Array.from({ length: 40 }, (_, index) =>
      message(`m${index}`, `later original ${index}`, 'later'),
    );
    await act(async () =>
      f.root.render(<Harness bridge={bridge} selected={selection('later', 3)} messages={values} />),
    );
    expect(
      requests
        .filter((request) => request.method === 'toolMessages.list')
        .map((request) => request.messageIds.length),
    ).toEqual([1, 32, 8]);
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(40);
    expect(
      requests.some(
        (request) =>
          request.method === 'toolMessages.close' && request.readId === heldRequest!.readId,
      ),
    ).toBe(true);
    await act(async () => release(pageFor(heldRequest!, 's')));
    expect(f.host.textContent).not.toContain('held old result');
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(40);
    hold = true;
    const changed = values.map((value, index) =>
      index === 0 ? { ...value, content: 'new unverified result' } : value,
    );
    await act(async () =>
      f.root.render(
        <Harness bridge={bridge} selected={selection('later', 3)} messages={changed} />,
      ),
    );
    expect(f.host.textContent).toContain('new unverified result');
    expect(f.host.querySelectorAll('.tool-activity')).toHaveLength(39);
  } finally {
    await f.close();
  }
});

test('live tool rows come only from current-Store active Run executions and remain distinct from Job completion or a stop request', async () => {
  const f = fixture();
  const execution: Execution = {
    id: 'live',
    originStoreId: 'store',
    sessionId: 's',
    runId: 'run',
    kind: 'tool',
    definitionId: 'shell.launch',
    definitionVersion: '1',
    status: 'running',
    result: null,
    resultRevision: '0',
    cancelRequestedAt: 1,
  };
  const selected: NativeSelection = {
    ...selection(),
    runs: [{ id: 'run', isActive: true }] as unknown as NativeSelection['runs'],
    executions: [
      execution,
      { ...execution, id: 'job', kind: 'job' },
      { ...execution, id: 'foreign', originStoreId: 'old' },
      { ...execution, id: 'other', sessionId: 'other' },
      { ...execution, id: 'old-run', runId: 'old' },
    ],
  };
  try {
    const live = liveToolMessages(selected, []);
    expect(live.map((entry) => entry.execution.id)).toEqual(['live']);
    await act(async () =>
      f.root.render(<NativeLiveToolMessage {...live[0]!} unavailable={false} />),
    );
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    expect(f.host.textContent).not.toContain('已停止');
    expect(f.host.querySelector('button')).toBeNull();
    await act(async () => f.root.render(<NativeLiveToolMessage {...live[0]!} unavailable />));
    expect(f.host.textContent).not.toContain('上次确认状态');
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    await act(async () =>
      f.root.render(
        <DesktopDiagnosticsProvider value>
          <NativeLiveToolMessage {...live[0]!} unavailable />
        </DesktopDiagnosticsProvider>,
      ),
    );
    expect(f.host.textContent).not.toContain('上次确认状态');
    expect(f.host.textContent).toContain('已请求停止，等待执行结果。');
    await act(async () =>
      f.root.render(
        <DesktopDiagnosticsProvider value>
          <NativeLiveToolMessage
            {...live[0]!}
            execution={{ ...live[0]!.execution, cancelRequestedAt: null }}
            unavailable
          />
        </DesktopDiagnosticsProvider>,
      ),
    );
    expect(f.host.textContent).toContain('上次确认状态');
    await act(async () =>
      f.root.render(
        <NativeLiveToolMessage
          {...live[0]!}
          message={{ ...live[0]!.message, executionUnconfirmed: true }}
          unavailable
        />,
      ),
    );
    expect(f.host.textContent).not.toContain('已请求停止，等待执行结果。');
    expect(
      liveToolMessages(selected, [{ ...message('result', 'recorded'), sourceIds: ['live'] }]),
    ).toEqual([]);
    expect(
      liveToolMessages(selected, [
        {
          ...message('foreign-result', 'old'),
          sourceIds: ['live'],
          originMessage: { storeId: 'old', sessionId: 's', runId: 'run', messageId: 'old' },
        },
      ]),
    ).toHaveLength(1);
    expect(
      liveToolMessages(
        {
          ...selected,
          runs: [{ id: 'run', isActive: false }] as unknown as NativeSelection['runs'],
        },
        [],
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

const statusExecution = (definitionId: string, status: Execution['status']): Execution => ({
  id: `status-${definitionId}`,
  originStoreId: 'store',
  sessionId: 's',
  runId: 'run',
  kind: 'tool',
  definitionId,
  definitionVersion:
    definitionId === 'files.read' ? '4' : definitionId.startsWith('files.') ? '2' : '1',
  status,
  result: status === 'succeeded' ? { outcome: 'succeeded', content: 'done' } : null,
  resultRevision: status === 'succeeded' ? '1' : '0',
  cancelRequestedAt: null,
});
const statusSelection = (executions: Execution[]): NativeSelection => ({
  ...selection(),
  runs: [
    {
      id: 'run',
      isActive: true,
      originStoreId: 'store',
      originCommandId: 'work',
      sessionId: 's',
      status: 'running',
      createdAt: 1,
      finishedAt: null,
      reason: null,
    },
  ],
  executions,
});

for (const definitionId of ['files.read', 'files.edit', 'files.write', 'task.list']) {
  test(`actual Native ${definitionId} rows distinguish queued, executing and settled results`, async () => {
    const f = fixture();
    try {
      for (const status of ['planned', 'dispatching', 'succeeded'] as const) {
        const execution = statusExecution(definitionId, status);
        const [live] = liveToolMessages(statusSelection([execution]), []);
        expect(live).toBeDefined();
        // Exercise the live transcript row and the retained ToolActivity branches.
        await act(async () =>
          f.root.render(
            <>
              <section data-case="live">
                <NativeLiveToolMessage {...live!} unavailable={false} />
              </section>
              <section data-case="retained">
                <NativeToolMessage
                  message={desktopToolMessage(
                    execution,
                    execution.id,
                    status === 'succeeded' ? 'done' : '',
                  )}
                />
              </section>
            </>,
          ),
        );
        for (const section of f.host.querySelectorAll('[data-case]')) {
          const active = section.querySelector('[data-slot="trace-line"][data-status="running"]');
          if (status === 'planned') {
            expect(section.textContent).toContain('等待执行');
            expect(section.textContent).not.toContain('执行中');
            expect(active).toBeNull();
            expect(
              section.querySelector('[data-slot="trace-line"][data-status="pending"]'),
            ).not.toBeNull();
          } else if (status === 'dispatching') {
            expect(section.textContent).toContain('执行中');
            expect(section.textContent).not.toContain('等待执行');
            expect(active).not.toBeNull();
          } else {
            expect(section.textContent).not.toContain('等待执行');
            expect(section.textContent).not.toContain('执行中');
            expect(active).toBeNull();
            expect(
              section.querySelector('[data-slot="trace-line"][data-status="pending"]'),
            ).toBeNull();
          }
        }
        expect(f.host.querySelector('.tool-activity')?.classList.contains('is-running')).toBe(
          status === 'dispatching',
        );
      }
    } finally {
      await f.close();
    }
  });
}

test('a mixed Native exploration batch shows the dispatched read as active while its sibling remains queued', async () => {
  const f = fixture();
  try {
    const live = liveToolMessages(
      statusSelection([
        statusExecution('files.read', 'dispatching'),
        { ...statusExecution('files.search', 'planned'), id: 'queued-search' },
      ]),
      [],
    );
    await act(async () =>
      f.root.render(
        <ToolActivity
          messages={live.map((entry) => entry.message)}
          expanded
          onToggle={() => {}}
          renderChildren={() => null}
        />,
      ),
    );
    expect(f.host.querySelector('.tool-activity-summary')?.textContent).toContain('读取文件');
    expect(f.host.querySelector('.tool-activity-summary')?.textContent).toBe('读取文件搜索内容');
    expect(f.host.querySelector('.tool-activity.is-running')).not.toBeNull();
    expect(f.host.querySelector('.tool-activity-step.running')?.textContent).toContain('执行中');
    expect(f.host.querySelector('.tool-activity-step.queued')?.textContent).toContain('等待执行');
  } finally {
    await f.close();
  }
});

test('Native execution labels preserve automatic check, human approval and refusal precedence', async () => {
  const f = fixture();
  const check: NonNullable<Execution['authorization']>['check'] = {
    executionId: 'check',
    status: 'running',
    decision: 'unavailable',
    reason: 'check',
    requireApproval: false,
  };
  const human: NonNullable<Execution['authorization']>['human'] = {
    interactionId: 'approval',
    state: 'pending',
    revision: '1',
    acceptedDecisionRevision: null,
    accepted: false,
    decision: null,
  };
  try {
    const cases = [
      {
        status: 'planned' as const,
        authorization: { dispatched: false, check },
        label: '正在自动审批',
      },
      {
        status: 'planned' as const,
        authorization: { dispatched: false, human },
        label: '等待人工审批',
      },
      {
        status: 'failed' as const,
        authorization: {
          dispatched: false,
          human: { ...human, state: 'answered' as const, decision: 'deny' as const },
        },
        label: '人工审批已拒绝',
      },
    ];
    for (const item of cases) {
      const execution = {
        ...statusExecution('files.edit', item.status),
        authorization: item.authorization,
      };
      const [live] = liveToolMessages(statusSelection([execution]), []);
      await act(async () =>
        f.root.render(
          <>
            <NativeLiveToolMessage {...live!} unavailable={false} />
            <NativeToolMessage message={desktopToolMessage(execution, execution.id, '')} />
          </>,
        ),
      );
      expect(f.host.textContent).toContain(item.label);
      expect(f.host.textContent).not.toContain('等待执行');
      expect(f.host.textContent).not.toContain('执行中');
      if (item.status === 'failed') expect(f.host.textContent).not.toContain('未执行');
    }
  } finally {
    await f.close();
  }
});

test('verified freshness rejections stay neutral in the real Native grouped transcript while one dispatched failure remains visible', async () => {
  const f = fixture();
  const messages = new Map<string, Message>(),
    executions = new Map<string, Execution>();
  for (let index = 0; index < 5; index++) {
    const id = `read-${index}`,
      code =
        index < 2
          ? 'context_refresh_required'
          : index < 4
            ? 'capability_refresh_required'
            : 'file_not_found';
    messages.set(id, { ...message(id, code), runId: 'r', seq: String(index + 1) });
    executions.set(`e-${id}`, {
      id: `e-${id}`,
      originStoreId: 'store',
      sessionId: 's',
      runId: 'r',
      kind: 'tool',
      definitionId: 'files.read',
      definitionVersion: '4',
      status: 'failed',
      resultRevision: '1',
      cancelRequestedAt: null,
      authorization: { dispatched: index === 4 },
      result: {
        outcome: 'failed',
        content: code,
        details: { code, adapterAttempted: index === 4, dispatchCommitted: index === 4 },
      },
    });
  }
  const manager = new NativeToolMessages(
    {
      verifyConnection: async () => {},
      getExecution: async (id: string) => executions.get(id)!,
    } as unknown as AgentClient,
    () => ({
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
    }),
    () => messages,
  );
  try {
    const facts = await manager.list({
      method: 'toolMessages.list',
      generation: 1,
      viewSelection: 2,
      historyEpoch: 0,
      readId: 'confirmed',
      messageIds: [...messages.keys()],
    });
    const transcript = desktopTranscript({
      messages: [...messages.values()],
      tools: facts.entries,
      storeId: 'store',
      sessionId: 's',
      runs: [
        {
          id: 'r',
          originStoreId: 'store',
          sessionId: 's',
          status: 'completed',
          isActive: false,
          createdAt: 1,
          finishedAt: 2,
          reason: null,
        },
      ],
    });
    expect(facts.entries.every((entry) => entry.status === 'failed')).toBe(true);
    expect(transcript.messages.filter((entry) => entry.status === 'not_executed')).toHaveLength(4);
    await act(async () =>
      f.root.render(
        <SessionPage
          workspaces={[]}
          sessionLabel="refresh"
          readingKey="s"
          loading={false}
          connected
          connectionLabel="local"
          actions={{}}
          messages={transcript.messages}
          renderToolActivity={(group, state) => (
            <ToolActivity {...state} messages={group} renderChildren={() => null} />
          )}
        />,
      ),
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('.agent-turn-summary')!.click());
    const group = f.host.querySelector<HTMLButtonElement>('.tool-activity-summary')!;
    expect(group.textContent).toContain('读取文件');
    expect(group.textContent).toBe('读取文件');
    await act(async () => group.click());
    expect(f.host.querySelectorAll('.tool-activity-step.not_executed')).toHaveLength(4);
    expect(
      f.host.querySelectorAll(
        '.tool-activity-steps > .tool-activity > button[data-status="error"]',
      ),
    ).toHaveLength(1);
    expect(f.host.textContent?.match(/上下文已更新，此次未执行/g)).toHaveLength(2);
    expect(f.host.textContent?.match(/工具信息已更新，此次未执行/g)).toHaveLength(2);
    expect(f.host.textContent).not.toContain('context_refresh_required');
    expect([...executions.values()].every((entry) => entry.status === 'failed')).toBe(true);
  } finally {
    manager.release();
    await f.close();
  }
});
