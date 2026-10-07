import { expect, test } from 'bun:test';
import type { Command, Interaction, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  activity,
  interactionAnswer,
  TuiController,
  type TuiFilePage,
  type TuiPort,
  TuiSession,
  type TuiSnapshot,
  terminalText,
} from '../../src/tui';

function snapshot(id = 'a', active = true): TuiSnapshot {
  return {
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'w',
        parentSessionId: null,
        rootSessionId: id,
        title: id,
        controlRevision: '0',
        contextSelectionId: 'selection',
        nextSeq: '1',
        deletedAt: null,
      },
      runs: active
        ? [
            {
              id: 'run',
              sessionId: id,
              originCommandId: 'original',
              originStoreId: 'store',
              status: 'waiting_execution',
              isActive: true,
              createdAt: 1,
              finishedAt: null,
              reason: null,
            },
          ]
        : [],
      executions: [],
      messages: [],
    } as SessionView,
    messages: [
      {
        id: 'message',
        sessionId: id,
        runId: active ? 'run' : null,
        seq: '1',
        status: 'complete',
        role: 'assistant',
        content: 'full正文尾部\u001b[2J',
      },
    ],
    interactions: [],
  };
}
const command = (id: string, sessionId: string): Command => ({
  id,
  sessionId,
  kind: 'test',
  originStoreId: 'store',
  status: 'accepted',
  receipt: {},
  cancelRequestedAt: null,
});
function fixture() {
  let next = 0,
    writes: unknown[] = [],
    cancels: unknown[] = [],
    reads = 0;
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `id${++next}`,
    listSessions: async () => [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ],
    readSession: async (id) => snapshot(id),
    submit: async (id, intent) => {
      writes.push({ id, intent });
      return { ...command(intent.commandId, id), kind: intent.kind };
    },
    answer: async (id, card, intent) => {
      writes.push({ id, card, intent });
      return {
        ...command(intent.commandId, id),
        kind: 'interaction.answer',
        status: 'applied',
        receipt: {
          outcome: 'answer_saved',
          interactionId: card,
          decisionRevision: (BigInt(intent.expectedRevision) + 1n).toString(),
        },
      };
    },
    cancel: async (id, intent) => {
      cancels.push({ id, intent });
      return command(intent.commandId, id);
    },
    getCommand: async (id, session) => {
      reads++;
      return { ...command(id, session), kind: 'run.start' };
    },
  };
  return { port, writes, cancels, reads: () => reads };
}
test('completed parent and current unfinished Jobs stay separate through clear, stale reads and Session selection', async () => {
  const f = fixture();
  let current = snapshot('a', false);
  const job = (id: string, status: SessionView['executions'][number]['status']) => ({
    id,
    sessionId: 'a',
    originStoreId: 'store',
    runId: 'completed-parent',
    kind: 'job' as const,
    definitionId: 'shell.command',
    definitionVersion: '1',
    status,
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
  });
  current.view.runs = [{ ...snapshot().view.runs[0]!, status: 'completed', isActive: false }];
  current.view.executions = [
    job('running', 'running'),
    { ...job('stopping', 'running'), cancelRequestedAt: 1 },
    job('queued', 'planned'),
    job('unknown', 'outcome_unknown'),
    job('finished', 'succeeded'),
    { ...job('other-session', 'running'), sessionId: 'b' },
    { ...job('restored-history', 'running'), originStoreId: 'prior-store' },
    { ...job('tool', 'running'), kind: 'tool' },
  ];
  f.port.readSession = async (id) => (id === 'a' ? current : snapshot(id, false));
  const controller = new TuiController(f.port);
  await controller.select('a');
  const app = render(<TuiSession controller={controller} />);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    await pause();
    expect(app.lastFrame()).toContain('Background Jobs: 3 unfinished · 1 unknown');
    expect(app.lastFrame()).toContain('full正文尾部');
    controller.clearDisplay();
    await pause();
    expect(app.lastFrame()).toContain('Background Jobs: 3 unfinished · 1 unknown');
    current = { ...current, view: { ...current.view, executions: [job('running', 'running')] } };
    await controller.select('a');
    await pause();
    expect(app.lastFrame()).toContain('Session a · Idle');
    expect(app.lastFrame()).toContain('Background Jobs: 1 unfinished · 0 unknown');
    controller.observationUnavailable('lost-observer');
    await pause();
    expect(app.lastFrame()).toContain('Stale');
    expect(app.lastFrame()).toContain('Background Jobs: 1 unfinished · 0 unknown');
    await controller.select('b');
    await pause();
    expect(app.lastFrame()).not.toContain('Background Jobs:');
    expect(f.writes).toEqual([]);
    expect(f.cancels).toEqual([]);
  } finally {
    app.unmount();
    app.cleanup();
    controller.dispose();
  }
});
test('active exact steer, idle start, unknown original lookup and precise cancel do not rebind or resend', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  await c.select('a');
  c.setDraft('原正文');
  await c.send();
  expect(f.writes[0]).toMatchObject({
    id: 'a',
    intent: {
      kind: 'input.steer',
      targetRunId: 'run',
      contextSelectionId: 'selection',
      expectedStoreId: 'store',
      content: '原正文',
    },
  });
  await Promise.all([c.cancel(), c.cancel()]);
  expect(f.cancels).toHaveLength(1);
  expect(f.cancels[0]).toMatchObject({ id: 'a', intent: { targetCommandId: 'original' } });
  f.port.readSession = async (id) => snapshot(id, false);
  await c.select('b');
  c.setDraft('idle');
  await c.send();
  expect(f.writes[1]).toMatchObject({ id: 'b', intent: { kind: 'run.start' } });
  f.port.submit = async () => {
    throw new Error('response lost');
  };
  c.setDraft('unconfirmed');
  await c.send();
  const original = c.state.intent!;
  expect(original.phase).toBe('unknown');
  await c.send();
  expect(f.writes).toHaveLength(2);
  await c.select('a');
  await c.lookup();
  expect(c.state.intent).toMatchObject({
    sessionId: 'b',
    commandId: original.commandId,
    phase: 'accepted',
  });
  expect(f.reads()).toBe(1);
  c.dispose();
  expect(f.cancels).toHaveLength(1);
});
test('late selected history fails closed, preserves same target stale snapshot and drafts, dispose aborts only reads', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  let release!: (value: TuiSnapshot) => void;
  let signal!: AbortSignal;
  f.port.readSession = async (id, s) => {
    if (id === 'a') {
      signal = s;
      return new Promise((r) => {
        release = r;
      });
    }
    return snapshot(id);
  };
  const old = c.select('a');
  await c.select('b');
  release(snapshot('a'));
  await old;
  expect(c.state.sessionId).toBe('b');
  expect(c.state.snapshot?.view.session.id).toBe('b');
  expect(signal.aborted).toBe(true);
  c.setDraft('保留');
  f.port.readSession = async () => {
    throw new Error('offline');
  };
  await c.select('b');
  expect(c.state.stale).toBe(true);
  expect(c.state.snapshot?.view.session.id).toBe('b');
  expect(c.state.draft).toBe('保留');
  c.dispose();
  expect(f.cancels).toHaveLength(0);
});
test('lost SSE observation survives healthy snapshot reads and Session switches until original Store ready', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  await c.select('a');
  c.setDraft('original draft');
  c.observationUnavailable('invalid_sse_response');
  await c.select('a');
  expect(c.state).toMatchObject({
    stale: true,
    snapshotStale: false,
    draft: 'original draft',
    observationError: 'observation_unavailable:invalid_sse_response',
  });
  await c.select('b');
  expect(c.state.snapshot?.view.session.id).toBe('b');
  expect(c.state.stale).toBe(true);
  expect(c.state.error).toBe('observation_unavailable:invalid_sse_response');
  await c.select('a');
  await c.send();
  expect(f.writes).toHaveLength(0);
  expect(c.state.draft).toBe('original draft');
  c.observationReady('wrong-store');
  expect(c.state.stale).toBe(true);
  expect(c.state.observationError).toBe('observation_unavailable:store_changed');
  await c.select('a');
  expect(c.state.stale).toBe(true);
  c.observationReady('store');
  expect(c.state.stale).toBe(false);
  expect(c.state.observationError).toBeUndefined();
  c.dispose();
  expect(f.cancels).toHaveLength(0);
});

test('validated observation ready cannot conceal a failed selected snapshot', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  await c.select('a');
  c.observationUnavailable('server_reset');
  f.port.readSession = async () => {
    throw Error('snapshot_unavailable');
  };
  await c.select('a');
  c.observationReady('store');
  expect(c.state).toMatchObject({
    stale: true,
    snapshotStale: true,
    error: 'snapshot_unavailable',
  });
  expect(c.state.observationError).toBeUndefined();
  expect(c.state.snapshot?.view.session.id).toBe('a');
  c.dispose();
});

const card: Interaction = {
  id: 'card',
  originStoreId: 'store',
  sessionId: 'child',
  presentationSessionId: 'a',
  ancestry: ['a', 'child'],
  runId: 'childrun',
  executionId: 'effect',
  attempt: 1,
  kind: 'approval',
  definitionId: 'shell',
  definitionVersion: '1',
  inputDigest: 'hash',
  policyRevision: 'p',
  requiredRefs: [],
  request: { grants: ['approve_once', 'same_command'] },
  answer: null,
  revision: '7',
  acceptedDecisionRevision: null,
  state: 'pending',
};
test('Ink ordinary text and Return in one native input block submit the exact current draft once', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  try {
    await Bun.sleep(20);
    app.stdin.write('owned task\r');
    await Bun.sleep(20);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({
      id: 'a',
      intent: {
        kind: 'run.start',
        expectedStoreId: 'store',
        commandId: 'id1',
        content: 'owned task',
      },
    });
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    app.cleanup();
    c.dispose();
  }
});
test('Ink text plus Return preserves slash completion and routes the complete export command once', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  const exports: unknown[] = [];
  f.port.exportLoadedText = {
    write: async (original) => {
      exports.push(original);
      return { path: '/owned/conversation.txt' };
    },
  };
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  try {
    await Bun.sleep(20);
    app.stdin.write('/exp\r');
    await Bun.sleep(20);
    expect(c.state.draft).toBe('/export');
    expect(exports).toHaveLength(0);
    app.stdin.write('\r');
    await Bun.sleep(20);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ storeId: 'store', sessionId: 'a' });
    app.stdin.write('/export\r');
    await Bun.sleep(20);
    expect(exports).toHaveLength(2);
    expect(f.writes).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    app.cleanup();
    c.dispose();
  }
});
test('Ink literal bracketed paste preserves CRLF and Ctrl bytes without submit or cancel until a separate Return', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  const original = '原文\r\nline\u0003';
  try {
    await Bun.sleep(20);
    app.stdin.write(`\u001b[200~${original}\u001b[201~`);
    await Bun.sleep(20);
    expect(c.state.draft).toBe(original);
    expect(f.writes).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
    app.stdin.write('\r');
    await Bun.sleep(20);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ id: 'a', intent: { content: original } });
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    app.cleanup();
    c.dispose();
  }
});
test('Ink text plus Return uses the updated file token and requires ready completion before a separate submit', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  const reads: {
    scope: TuiFilePage['scope'];
    query: string;
    resolve(page: TuiFilePage): void;
  }[] = [];
  f.port.fileCandidates = {
    read: (scope, input) =>
      new Promise((resolve) => reads.push({ scope, query: input.query, resolve })),
  };
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  const finish = (index: number) => {
    const original = reads[index]!;
    original.resolve({
      scope: original.scope,
      query: original.query,
      snapshotId: 'original',
      paths: ['src/文件 空格.txt'],
      nextCursor: null,
      unavailable: [],
    });
  };
  try {
    await Bun.sleep(20);
    app.stdin.write('@s\r');
    await Bun.sleep(20);
    expect(c.state.draft).toBe('@s');
    expect(f.writes).toHaveLength(0);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      query: 's',
      scope: { storeId: 'store', sessionId: 'a', workspaceId: 'w' },
    });
    finish(0);
    await Bun.sleep(20);
    app.stdin.write('r\r');
    await Bun.sleep(20);
    expect(c.state.draft).toBe('@sr');
    expect(f.writes).toHaveLength(0);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.query).toBe('sr');
    finish(1);
    await Bun.sleep(20);
    app.stdin.write('\r');
    await Bun.sleep(20);
    expect(c.state.draft).toBe('@"src/文件 空格.txt"');
    expect(f.writes).toHaveLength(0);
    app.stdin.write('\r');
    await Bun.sleep(20);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toMatchObject({ id: 'a', intent: { content: '@"src/文件 空格.txt"' } });
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    app.cleanup();
    c.dispose();
  }
});
for (const surface of ['approval', 'composer'] as const) {
  test(`native Ctrl+C batch cancels only the original work once on ${surface}; literal paste stays text`, async () => {
    const f = fixture();
    f.port.readSession = async (id) => ({
      ...snapshot(id),
      interactions: surface === 'approval' ? [card] : [],
    });
    const c = new TuiController(f.port);
    await c.select('a');
    c.setDraft('kept main');
    const app = render(<TuiSession controller={c} />);
    try {
      await Bun.sleep(20);
      app.stdin.write('\u001b[200~\u0003\u0003\u001b[201~');
      await Bun.sleep(20);
      expect(f.cancels).toHaveLength(0);
      expect(f.writes).toHaveLength(0);
      const pastedDraft = surface === 'composer' ? 'kept main\u0003\u0003' : 'kept main';
      expect(c.state.draft).toBe(pastedDraft);
      app.stdin.write('\u0003\u0003');
      await Bun.sleep(20);
      expect(f.cancels).toHaveLength(1);
      expect(f.cancels[0]).toMatchObject({ id: 'a', intent: { targetCommandId: 'original' } });
      expect(c.state.draft).toBe(pastedDraft);
      expect(app.lastFrame()).not.toContain('\\u0003\\u0003\\u0003\\u0003');
      app.stdin.write('\u0003');
      await Bun.sleep(20);
      expect(f.cancels).toHaveLength(1);
      expect(f.writes).toHaveLength(0);
    } finally {
      app.unmount();
      app.cleanup();
      c.dispose();
    }
  });
}
test('only original offered approval grants, EOF/blank and question never default approve; saved receipt is not success', async () => {
  expect(interactionAnswer(card, '')).toBeUndefined();
  expect(interactionAnswer(card, 'approve')).toEqual({
    kind: 'approval',
    decision: 'approve',
    grant: 'approve_once',
  });
  expect(interactionAnswer(card, 'approve same_command')).toMatchObject({ grant: 'same_command' });
  expect(interactionAnswer({ ...card, request: {} }, 'approve same_command')).toBeUndefined();
  expect(
    interactionAnswer(
      { ...card, kind: 'question', request: { schema: { type: 'object' } } },
      'approve',
    ),
  ).toBeUndefined();
  const f = fixture();
  f.port.readSession = async () => ({ ...snapshot(), interactions: [card] });
  const c = new TuiController(f.port);
  await c.select('a');
  await c.answer(card, 'approve same_command');
  expect(f.writes[0]).toMatchObject({
    id: 'a',
    card: 'card',
    intent: { expectedStoreId: 'store', expectedRevision: '7', answer: { grant: 'same_command' } },
  });
  expect(c.state.intent?.phase).toBe('applied');
  expect(activity(c.state.snapshot)).toBe('Waiting for required result');
  c.dispose();
});
test('Ink actual keyboard session selection and full terminal-safe history preserves complete text without control execution', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  await c.select('a');
  const rendered = render(<TuiSession controller={c} />);
  await Bun.sleep(40);
  expect(rendered.lastFrame()).toContain('full正文尾部\\u001b[2J');
  expect(rendered.lastFrame()).toContain('Waiting for required result');
  rendered.stdin.write('\u0012');
  await Bun.sleep(20);
  expect(rendered.lastFrame()).toContain('Select Session');
  rendered.stdin.write('\u001b[B');
  await Bun.sleep(20);
  rendered.stdin.write('\r');
  await Bun.sleep(50);
  expect(c.state.sessionId).toBe('b');
  expect(terminalText('\u0000x\u202e')).toBe('\\u0000x\\u202e');
  rendered.unmount();
  c.dispose();
});

test('complete 201-message history and verified giant Fork output use observed origin; unsupported and late reads show no guessed body', async () => {
  const f = fixture();
  const base = snapshot('fork', false);
  const original = {
    ...base.messages[0]!,
    id: 'fork-message',
    sessionId: 'fork',
    runId: 'forkrun',
    originMessage: {
      storeId: 'store',
      sessionId: 'original',
      messageId: 'original-message',
      runId: 'originalrun',
    },
    outputBody: {
      kind: 'model_output' as const,
      executionId: 'original-exec',
      complete: true,
      contentBytes: '17825800',
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  const messages = Array.from({ length: 201 }, (_, i) => ({
    ...original,
    id: i === 200 ? 'fork-message' : `message-${i}`,
    seq: String(i + 1),
    content: `message ${i} original full text`,
  }));
  f.port.readSession = async () => ({ ...base, messages });
  const body = `${'x'.repeat(17 * 1024 * 1024)}完整尾部`;
  const reads: { sessionId: string; executionId: string }[] = [];
  f.port.readModelOutput = async (sessionId, executionId) => {
    reads.push({ sessionId, executionId });
    return {
      storeId: 'store',
      sessionId,
      rootSessionId: 'original',
      runId: 'originalrun',
      executionId,
      originCommandId: 'work',
      rootWorkCommandId: 'work',
      rootWorkSeq: '1',
      attempt: 1,
      status: 'succeeded',
      bodyHash: 'verified-by-host',
      bodyBytes: '17825800',
      contentBytes: '17825800',
      reasoningBytes: '0',
      snapshotCursor: '1',
      output: { content: body, reasoning: '', toolCalls: [], complete: true },
    };
  };
  const c = new TuiController(f.port);
  await c.select('fork');
  expect(c.state.snapshot?.messages).toHaveLength(201);
  await c.loadOutput(messages[200]!);
  expect(reads).toEqual([{ sessionId: 'original', executionId: 'original-exec' }]);
  expect(c.state.fullOutputs.get('fork-message')).toBe(body);
  f.port.readSession = async () => ({
    ...base,
    messages: [
      { ...original, outputBody: { ...original.outputBody, readAvailability: 'unsupported' } },
    ],
  });
  await c.select('fork');
  await c.loadOutput(original);
  expect(reads).toHaveLength(1);
  expect(c.state.fullOutputs.size).toBe(0);
  const foreign = { ...original, originMessage: { ...original.originMessage, storeId: 'foreign' } };
  f.port.readSession = async () => ({ ...base, messages: [foreign] });
  await c.select('fork');
  await c.loadOutput(foreign);
  expect(reads).toHaveLength(1);
  expect(c.state.error).toBe('tui_origin_store_unavailable');
  c.dispose();
});

test('late output and disposed observer cannot publish or reopen reads, failed attachments keep original card waiting', async () => {
  const f = fixture(),
    c = new TuiController(f.port);
  const message = {
    ...snapshot().messages[0]!,
    outputBody: {
      kind: 'model_output' as const,
      executionId: 'output',
      complete: true,
      contentBytes: '1',
      reasoningBytes: '0',
      toolCallCount: 0,
    },
  };
  f.port.readSession = async (id) => ({
    ...snapshot(id),
    messages: [{ ...message, sessionId: id }],
    interactions: [{ ...card, presentationSessionId: id }],
  });
  let release!: (value: import('@kite-ai/client').ModelOutputSnapshot) => void,
    signal!: AbortSignal;
  f.port.readModelOutput = async (_id, _execution, s) => {
    signal = s;
    return new Promise((r) => {
      release = r;
    });
  };
  await c.select('a');
  const reading = c.loadOutput(message);
  await c.select('b');
  release({
    storeId: 'store',
    sessionId: 'a',
    rootSessionId: 'a',
    runId: 'run',
    executionId: 'output',
    originCommandId: 'original',
    rootWorkCommandId: 'original',
    rootWorkSeq: '1',
    attempt: 1,
    status: 'succeeded',
    bodyHash: 'hostverified',
    bodyBytes: '1',
    contentBytes: '1',
    reasoningBytes: '0',
    snapshotCursor: '1',
    output: { content: 'x', reasoning: '', toolCalls: [], complete: true },
  });
  await reading;
  expect(signal.aborted).toBe(true);
  expect(c.state.fullOutputs.size).toBe(0);
  f.port.readAttachment = async () => {
    throw new Error('scope_denied');
  };
  await c.loadAttachment({ ...card, presentationSessionId: 'b' });
  expect(c.state.error).toBe('scope_denied');
  expect(c.state.attachment).toBeUndefined();
  c.dispose();
  let reads = 0;
  f.port.readSession = async () => {
    reads++;
    return snapshot();
  };
  await c.select('a');
  expect(reads).toBe(0);
  expect(f.cancels).toHaveLength(0);
});

test('independent Markdown AST renders structures and keeps HTML, media, relative paths and control protocols as full safe text', async () => {
  const { TerminalMarkdown } = await import('../../src/tui');
  const content =
    '# Title\n\nParagraph **bold** and `code`.\n\n- item\n\n> quote\n\n```ts\nconst x=1;\n```\n\n| A | B |\n|---|---|\n| left | right |\n\n<script>unsafe()</script>\n\n![alt](https://invalid.example/image) [file](./relative.ts)\n\n\u001b]8;;https://invalid.example\u0007full tail';
  const terminal = render(<TerminalMarkdown content={content} />);
  await Bun.sleep(30);
  const frame = terminal.lastFrame()!;
  expect(frame).toContain('Title');
  expect(frame).toContain('const x=1;');
  expect(frame).toContain('left | right');
  expect(frame).toContain('<script>unsafe()</script>');
  expect(frame).toContain('./relative.ts');
  expect(frame).toContain('image: alt');
  expect(frame).toContain('\\u001b]8;;https://invalid.example\\u0007full tail');
  terminal.unmount();
});

for (const mismatch of [
  'kind',
  'store',
  'session',
  'id',
  'interaction',
  'revision',
  'outcome',
  'status',
]) {
  test(`unknown original answer rejects ${mismatch} receipt after terminal work, switching and cancel`, async () => {
    const f = fixture();
    f.port.readSession = async (id) => ({
      ...snapshot(id),
      interactions: id === 'a' ? [card] : [],
    });
    let posts = 0;
    let frozen!: Parameters<TuiPort['answer']>[2];
    f.port.answer = async (_session, _interaction, request) => {
      posts++;
      frozen = request;
      throw new Error('answer POST response lost');
    };
    const c = new TuiController(f.port);
    await c.select('a');
    await c.answer(card, 'approve');
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.answer)).toBe(true);
    const original = c.state.intent!;
    await c.cancel();
    expect(f.cancels).toHaveLength(1);
    expect(f.cancels[0]).toMatchObject({ id: 'a', intent: { targetCommandId: 'original' } });
    expect(c.state.intent).toEqual(original);
    f.port.readSession = async (id) => snapshot(id, false);
    await c.select('b');
    let gets = 0;
    const valid: Command = {
      ...command(original.commandId, 'a'),
      kind: 'interaction.answer',
      status: 'applied',
      receipt: { outcome: 'answer_saved', interactionId: 'card', decisionRevision: '8' },
    };
    const invalid = structuredClone(valid);
    if (mismatch === 'kind') invalid.kind = 'run.start';
    if (mismatch === 'store') invalid.originStoreId = 'other';
    if (mismatch === 'session') invalid.sessionId = 'b';
    if (mismatch === 'id') invalid.id = 'another';
    if (mismatch === 'status') invalid.status = 'accepted';
    if (['interaction', 'revision', 'outcome'].includes(mismatch))
      invalid.receipt = {
        outcome: mismatch === 'outcome' ? 'other' : 'answer_saved',
        interactionId: mismatch === 'interaction' ? 'other' : 'card',
        decisionRevision: mismatch === 'revision' ? '9' : '8',
      };
    f.port.getCommand = async (id, session) => {
      expect(id).toBe(original.commandId);
      expect(session).toBe('a');
      return ++gets === 1 ? invalid : valid;
    };
    await c.lookup();
    expect(c.state.intent?.phase).toBe('unknown');
    await c.answer(card, 'approve');
    await c.send();
    expect(posts).toBe(1);
    await c.lookup();
    expect(c.state.intent).toMatchObject({
      sessionId: 'a',
      commandId: original.commandId,
      phase: 'applied',
    });
    await c.select('a');
    f.port.readSession = async () => ({ ...snapshot(), interactions: [card] });
    await c.select('a');
    await c.answer(card, 'approve');
    expect(posts).toBe(1);
    expect(gets).toBe(2);
    c.dispose();
  });
}

test('Ink Ctrl+L restores the frozen answer GET before refreshing and clearing only the terminal display', async () => {
  const f = fixture();
  let terminal = false;
  const events: string[] = [];
  f.port.readSession = async (id) => {
    events.push(`read:${id}`);
    return { ...snapshot(id, !terminal), interactions: terminal ? [] : [card] };
  };
  f.port.answer = async () => {
    throw new Error('lost answer response');
  };
  const c = new TuiController(f.port);
  await c.select('a');
  await c.answer(card, 'approve');
  const original = c.state.intent!;
  terminal = true;
  await c.select('b');
  events.length = 0;
  f.port.getCommand = async (id, session) => {
    events.push(`get:${session}:${id}`);
    return {
      ...command(id, session),
      kind: 'interaction.answer',
      status: 'applied',
      receipt: { outcome: 'answer_saved', interactionId: 'card', decisionRevision: '8' },
    };
  };
  const rendered = render(<TuiSession controller={c} />);
  await Bun.sleep(25);
  rendered.stdin.write('\u000c');
  await Bun.sleep(40);
  expect(events).toEqual([`get:a:${original.commandId}`, 'read:b']);
  expect(c.state.sessionId).toBe('b');
  expect(c.state.intent).toMatchObject({ sessionId: 'a', phase: 'applied' });
  expect(c.state.snapshot?.messages).toHaveLength(1);
  expect(c.visibleMessages).toHaveLength(0);
  expect(rendered.lastFrame()).not.toContain('full正文尾部');
  rendered.unmount();
  c.dispose();
});

test('clear preserves the full history, pending approval, draft and active work while new display facts remain visible', async () => {
  const f = fixture();
  let current = {
    ...snapshot(),
    interactions: [card],
    view: {
      ...snapshot().view,
      executions: [
        {
          id: 'done',
          kind: 'tool',
          status: 'succeeded',
          resultRevision: '1',
        },
        {
          id: 'uncertain',
          kind: 'tool',
          status: 'outcome_unknown',
          resultRevision: null,
        },
      ] as SessionView['executions'],
    },
  };
  f.port.readSession = async (id) => (id === 'a' ? current : snapshot(id));
  const c = new TuiController(f.port);
  await c.select('a');
  c.setDraft('retained text');
  const original = c.state.snapshot;
  const originalActivity = activity(original);
  c.clearDisplay();
  expect(c.state.snapshot).toBe(original);
  expect(c.state.draft).toBe('retained text');
  expect(c.state.snapshot?.interactions).toEqual([card]);
  expect(activity(c.state.snapshot)).toBe(originalActivity);
  expect(c.visibleMessages).toHaveLength(0);
  expect(c.visibleExecutions.map((execution) => execution.id)).toEqual(['uncertain']);
  await c.select('a');
  expect(c.visibleMessages).toHaveLength(0);
  // Even a port that updates its original DTO cannot change the captured display baseline.
  current.messages[0]!.content = 'new actual content';
  await c.select('a');
  expect(c.visibleMessages.map((message) => message.content)).toEqual(['new actual content']);
  current = {
    ...current,
    messages: [...current.messages, { ...current.messages[0]!, id: 'next', seq: '2' }],
  };
  await c.select('a');
  expect(c.visibleMessages.map((message) => message.id)).toEqual(['message', 'next']);
  await c.select('b');
  expect(c.visibleMessages).toHaveLength(1);
  await c.select('a');
  expect(c.visibleMessages).toHaveLength(2);
  expect(f.writes).toEqual([]);
  expect(f.cancels).toEqual([]);
  c.dispose();
});

test('lost cancel receipt retains its own original GET after the unknown answer is recovered', async () => {
  const f = fixture();
  f.port.readSession = async () => ({ ...snapshot(), interactions: [card] });
  f.port.answer = async () => {
    throw new Error('lost answer');
  };
  f.port.cancel = async () => {
    throw new Error('lost cancel');
  };
  const c = new TuiController(f.port);
  await c.select('a');
  await c.answer(card, 'approve');
  const answerId = c.state.intent!.commandId;
  await c.cancel();
  const gets: string[] = [];
  f.port.getCommand = async (id, session) => {
    gets.push(`${session}/${id}`);
    return id === answerId
      ? {
          ...command(id, session),
          kind: 'interaction.answer',
          status: 'applied',
          receipt: { outcome: 'answer_saved', interactionId: 'card', decisionRevision: '8' },
        }
      : { ...command(id, session), kind: 'command.cancel', status: 'applied' };
  };
  await c.lookup();
  await c.lookup();
  expect(gets).toEqual(['a/id1', 'a/id2']);
  expect(c.state.intent).toMatchObject({
    kind: 'command.cancel',
    phase: 'applied',
    sessionId: 'a',
  });
  c.dispose();
});

for (const blocked of ['stale', 'unknown'] as const)
  test(`Ink composer editing preserves ${blocked} guard and emits zero new task POST`, async () => {
    const f = fixture(),
      c = new TuiController(f.port);
    await c.select('a');
    if (blocked === 'stale') c.observationUnavailable('owned_negative');
    else {
      f.port.submit = async (id, intent) => {
        f.writes.push({ id, intent });
        throw Error('original response lost');
      };
      c.setDraft('original unknown');
      await c.send();
      expect(c.state.intent?.phase).toBe('unknown');
    }
    const before = f.writes.length,
      app = render(<TuiSession controller={c} />);
    try {
      await Bun.sleep(20);
      app.stdin.write('编辑🙂');
      await Bun.sleep(20);
      app.stdin.write('\r');
      await Bun.sleep(20);
      expect(c.state.draft).toContain('编辑🙂');
      expect(f.writes).toHaveLength(before);
      expect(f.cancels).toHaveLength(0);
    } finally {
      app.unmount();
      c.dispose();
    }
  });

test('pending chooser preserves independent original card drafts and clears only changed revisions without POST', async () => {
  const f = fixture();
  let cards = [
    { ...card, id: 'sibling-a', kind: 'question' as const },
    { ...card, id: 'sibling-b', sessionId: 'child-b', kind: 'question' as const },
    { ...card, id: 'root-card', sessionId: 'a', kind: 'question' as const },
  ];
  f.port.readSession = async () => ({ ...snapshot(), interactions: cards });
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  const key = async (input: string) => {
    app.stdin.write(input);
    await Bun.sleep(20);
  };
  try {
    await Bun.sleep(20);
    await key('A独立草稿');
    await key('\x02');
    expect(app.lastFrame()).toContain('Pending cards · 3');
    await key('\x1b[B');
    await key('\r');
    await key('B独立草稿');
    await key('\x02');
    await key('\x1b[A');
    await key('\r');
    expect(app.lastFrame()).toContain('A独立草稿');
    expect(app.lastFrame()).not.toContain('B独立草稿');
    cards = cards.map((item) => (item.id === 'sibling-a' ? { ...item, revision: '8' } : item));
    await c.select('a');
    await Bun.sleep(20);
    expect(app.lastFrame()).not.toContain('A独立草稿');
    await key('\x02');
    await key('\x1b[B');
    await key('\r');
    expect(app.lastFrame()).toContain('B独立草稿');
    expect(f.writes).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    c.dispose();
  }
});

test('independent complete attachments retain original scopes across selection; revised card cannot borrow earlier review', async () => {
  const f = fixture();
  const attached = (id: string, source: string): Interaction => ({
    ...card,
    id,
    sessionId: source,
    request: {
      grants: ['approve_once'],
      policy: {
        review: {
          kind: 'artifact',
          complete: true,
          reference: {
            id: `body-${id}`,
            mediaType: 'text/plain',
            size: '100001',
            scope: { kind: 'execution', id: `effect-${id}` },
          },
        },
      },
    },
  });
  let cards = [attached('one', 'child-one'), attached('two', 'child-two')];
  f.port.readSession = async (id) => ({ ...snapshot(id), interactions: id === 'a' ? cards : [] });
  const bodies = new Map(
    cards.map((item) => [
      item.id,
      `${item.sessionId} ${'完整正文'.repeat(25000)} EXACT_${item.id}`,
    ]),
  );
  const reads: string[] = [];
  f.port.readAttachment = async (item) => {
    reads.push(
      `${item.originStoreId}/${item.sessionId}/${item.presentationSessionId}/${item.id}/${item.revision}`,
    );
    return bodies.get(item.id)!;
  };
  const c = new TuiController(f.port);
  await c.select('a');
  await c.loadAttachment(cards[0]!);
  await c.loadAttachment(cards[1]!);
  expect(c.state.attachments.size).toBe(2);
  expect([...c.state.attachments.values()]).toEqual([...bodies.values()]);
  await c.select('b');
  await c.select('a');
  expect(c.state.attachments.size).toBe(2);
  cards = cards.map((item) => (item.id === 'one' ? { ...item, revision: '8' } : item));
  await c.select('a');
  expect(c.state.attachments.size).toBe(1);
  await c.answer(cards[0]!, 'approve');
  expect(f.writes).toHaveLength(0);
  await c.loadAttachment(cards[0]!);
  expect(c.state.attachments.size).toBe(2);
  expect(reads).toEqual([
    'store/child-one/a/one/7',
    'store/child-two/a/two/7',
    'store/child-one/a/one/8',
  ]);
  c.dispose();
});

test('open pending chooser freezes exact original rows when the paged directory changes', async () => {
  const f = fixture();
  let cards = [
    { ...card, id: 'one' },
    { ...card, id: 'two', sessionId: 'other-child' },
  ];
  f.port.readSession = async () => ({ ...snapshot(), interactions: cards });
  const c = new TuiController(f.port);
  await c.select('a');
  const app = render(<TuiSession controller={c} />);
  const key = async (input: string) => {
    app.stdin.write(input);
    await Bun.sleep(20);
  };
  try {
    await Bun.sleep(20);
    await key('\x02');
    await key('\x1b[B');
    cards = [{ ...cards[0]! }, { ...cards[1]!, revision: '8' }, { ...card, id: 'new-card' }];
    await c.select('a');
    await Bun.sleep(20);
    expect(app.lastFrame()).toContain('changed; reopen to select');
    await key('\r');
    expect(app.lastFrame()).toContain('approval [one]');
    expect(app.lastFrame()).not.toContain('approval [new-card]');
    expect(f.writes).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
  } finally {
    app.unmount();
    c.dispose();
  }
});

for (const blocked of ['unknown-observation', 'preparation-close', 'preparation-switch'] as const)
  test(`single Job stop ${blocked} emits zero POST and never cancels parent`, async () => {
    const f = fixture();
    const actual = {
      id: 'job-one',
      originStoreId: 'store',
      sessionId: 'a',
      runId: null,
      kind: 'job' as const,
      definitionId: 'ordinary',
      definitionVersion: '1',
      status: 'running' as const,
      result: null,
      resultRevision: '0',
      cancelRequestedAt: null,
      parentExecutionId: 'parent',
      childSessionId: null,
    };
    f.port.readSession = async (id) => ({
      ...snapshot(id, false),
      interactions: [],
      view: { ...snapshot(id, false).view, executions: id === 'a' ? [actual] : [] },
    });
    let post = 0,
      finish!: (value: typeof actual) => void;
    f.port.executions = {
      getExecution: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      output: async () => {
        throw Error('unused');
      },
      getView: async () => {
        throw Error('unused');
      },
      messages: async () => {
        throw Error('unused');
      },
      modelOutput: async () => {
        throw Error('unused');
      },
      stop: async () => {
        post++;
        throw Error('forbidden');
      },
      getCommand: async () => {
        throw Error('unused');
      },
    };
    const c = new TuiController(f.port);
    await c.select('a');
    c.openExecutions();
    if (blocked === 'unknown-observation') {
      c.observationUnavailable('SSE lost');
      await c.stopJob('job-one');
    } else {
      const pending = c.stopJob('job-one');
      await Bun.sleep(0);
      if (blocked === 'preparation-close') c.closePanel();
      else await c.select('b');
      finish(actual);
      await pending;
    }
    expect(post).toBe(0);
    expect(f.cancels).toHaveLength(0);
    expect(c.state.jobStops.size).toBe(0);
    c.dispose();
  });

test('single Job lost response survives Session switch and close; lookup keeps original scope and zero new POST', async () => {
  const f = fixture(),
    job = {
      id: 'job-one',
      originStoreId: 'store',
      sessionId: 'a',
      runId: null,
      kind: 'job' as const,
      definitionId: 'one',
      definitionVersion: '1',
      status: 'running' as const,
      result: null,
      resultRevision: '0',
      cancelRequestedAt: null,
      parentExecutionId: 'parent',
      childSessionId: null,
    };
  f.port.readSession = async (id) => ({
    ...snapshot(id, false),
    view: {
      ...snapshot(id, false).view,
      executions: id === 'a' ? [job] : [{ ...job, id: 'job-two', sessionId: id }],
    },
  });
  const posts: unknown[] = [],
    gets: string[] = [];
  f.port.executions = {
    getExecution: async () => job,
    output: async () => {
      throw Error('unused');
    },
    getView: async () => {
      throw Error('unused');
    },
    messages: async () => {
      throw Error('unused');
    },
    modelOutput: async () => {
      throw Error('unused');
    },
    stop: async (session, request) => {
      posts.push({ session, request });
      throw Error('physical response lost');
    },
    getCommand: async (id) => {
      gets.push(id);
      return {
        ...command(id, 'a'),
        kind: 'execution.cancel',
        status: 'applied',
        receipt: {
          kind: 'execution.cancel',
          executionId: 'job-two',
          outcome: 'cancel_requested',
          affectedCount: 1,
        },
      };
    },
  };
  const c = new TuiController(f.port);
  await c.select('a');
  c.openExecutions();
  await c.stopJob('job-one');
  const intent = [...c.state.jobStops.values()][0]!;
  expect(intent.phase).toBe('unknown');
  c.closePanel();
  await c.select('b');
  c.openExecutions();
  await c.stopJob('job-two');
  await c.lookup();
  expect([...c.state.jobStops.values()][0]!.phase).toBe('unknown');
  expect(posts).toEqual([
    {
      session: 'a',
      request: {
        kind: 'execution.cancel',
        expectedStoreId: 'store',
        commandId: intent.request.commandId,
        executionId: 'job-one',
      },
    },
  ]);
  expect(gets).toEqual([intent.request.commandId]);
  expect(f.cancels).toHaveLength(0);
  c.dispose();
});

test('cold caller GET cannot clear later draft or single-use Plan mode; reader cancellation and wrong full identity keep original unknown', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  const intent = {
    scope: { storeId: 'store', sessionId: 'a', workspaceId: 'w' },
    request: {
      kind: 'run.start' as const,
      expectedStoreId: 'store',
      commandId: 'cold-original',
      content: 'old request',
      extensionInputs: [
        { extensionId: 'builtin.planning', definitionVersion: '1', input: { mode: 'plan' } },
      ],
    },
    target: { kind: 'session' as const, id: 'a' },
    subjectId: 'original-subject',
    bodyDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    draft: { id: 'c'.repeat(64), revision: '1', textDigest: 'd'.repeat(64) },
  };
  let reads = 0;
  f.port.callers = {
    list: async () => [{ intent, phase: 'unknown' }],
    prepare: async () => {
      throw Error('unexpected prepare');
    },
    submit: async () => {
      throw Error('unexpected POST');
    },
    clear: async () => {
      throw Error('unknown cannot clear');
    },
    lookup: async (original) => {
      reads++;
      return {
        intent: original,
        phase: 'applied',
        command: {
          ...command('cold-original', 'a'),
          kind: 'run.start',
          status: 'applied',
          receipt: { runId: 'original-run' },
        },
      };
    },
  };
  const c = new TuiController(f.port);
  await c.restoreCallers();
  await c.select('a');
  c.setDraft('NEW DRAFT🙂');
  c.togglePlanning();
  await c.openRecovery();
  expect(c.state.panel).toBe('recovery');
  const key = [...c.state.callers.keys()][0]!;
  await c.lookupCaller(key);
  expect(reads).toBe(1);
  expect(c.state.draft).toBe('NEW DRAFT🙂');
  expect(c.state.planning).toBe(true);
  expect(f.writes).toHaveLength(0);
  f.port.callers.list = async () => [
    { intent: { ...intent, scope: { ...intent.scope, workspaceId: 'wrong-w' } }, phase: 'unknown' },
  ];
  await c.restoreCallers();
  expect(c.state.callerUnavailable).toBe('caller_restore_conflict');
  expect(c.state.callers.get(key)?.intent.scope.workspaceId).toBe('w');
  f.port.callers.list = async () => [{ intent, phase: 'unknown' }];
  c.dispose();
  f.port.callers.lookup = async (original) => ({
    intent: { ...original, subjectId: 'wrong-subject' },
    phase: 'applied',
  });
  const cold = new TuiController(f.port);
  await cold.restoreCallers();
  await cold.select('a');
  await cold.lookupCaller(key);
  expect(cold.state.callers.get(key)?.phase).toBe('unknown');
  let aborted = false;
  f.port.callers.lookup = (original, signal) =>
    new Promise((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve({ intent: original, phase: 'unknown' });
        },
        { once: true },
      ),
    );
  const waiting = cold.lookupCaller(key);
  cold.cancelCallerRead();
  await waiting;
  expect(aborted).toBe(true);
  expect(cold.state.callers.get(key)?.phase).toBe('unknown');
  expect(f.writes).toHaveLength(0);
  cold.dispose();
});

test('prepare refusal is zero POST and retains original draft; a later explicit retry may use a new Command', async () => {
  const f = fixture();
  f.port.readSession = async (id) => snapshot(id, false);
  let prepares = 0,
    posts = 0;
  f.port.callers = {
    list: async () => [],
    prepare: async () => {
      prepares++;
      throw Error('caller_intent_limit');
    },
    submit: async () => {
      posts++;
      throw Error('unexpected');
    },
    lookup: async () => {
      throw Error('unexpected');
    },
    clear: async () => {
      throw Error('unexpected');
    },
  };
  const c = new TuiController(f.port);
  await c.select('a');
  c.setDraft('原完整正文');
  await c.send();
  expect(c.state.intent?.phase).toBe('rejected');
  expect(c.state.error).toBe('caller_intent_limit');
  expect(c.state.draft).toBe('原完整正文');
  await c.send();
  expect(prepares).toBe(2);
  expect(posts).toBe(0);
  c.dispose();
});

test('capacity refusal never strands a cancellation or exact Job stop as unknown before any POST', async () => {
  const f = fixture();
  let prepares = 0,
    posts = 0;
  f.port.callers = {
    list: async () => [],
    prepare: async () => {
      prepares++;
      throw Error('caller_capacity_exceeded');
    },
    submit: async () => {
      posts++;
      throw Error('unexpected');
    },
    lookup: async () => {
      throw Error('unexpected');
    },
    clear: async () => {
      throw Error('unexpected');
    },
  };
  const c = new TuiController(f.port);
  await c.select('a');
  await c.cancel();
  await c.cancel();
  expect(prepares).toBe(2);
  expect(posts).toBe(0);
  expect(c.state.intent?.phase).toBe('rejected');
  c.dispose();
  const job = {
    id: 'job-one',
    originStoreId: 'store',
    sessionId: 'a',
    runId: null,
    kind: 'job' as const,
    definitionId: 'one',
    definitionVersion: '1',
    status: 'running' as const,
    result: null,
    resultRevision: '0',
    cancelRequestedAt: null,
    parentExecutionId: null,
    childSessionId: null,
  };
  f.port.readSession = async (id) => {
    const s = snapshot(id, false);
    s.view.executions = [job];
    return s;
  };
  const unused = async (): Promise<never> => {
    throw Error('unexpected execution mutation or reader');
  };
  f.port.executions = {
    getExecution: async () => job,
    output: unused,
    getView: unused,
    messages: unused,
    modelOutput: unused,
    stop: unused,
    getCommand: unused,
  };
  const j = new TuiController(f.port);
  await j.select('a');
  await j.stopJob('job-one');
  await j.stopJob('job-one');
  expect(prepares).toBe(4);
  expect(posts).toBe(0);
  expect([...j.state.jobStops.values()].map((i) => i.phase)).toEqual(['rejected', 'rejected']);
  expect(j.state.error).toBe('caller_capacity_exceeded');
  j.dispose();
});
