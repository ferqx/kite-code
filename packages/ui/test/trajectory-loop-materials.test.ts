import { projectTrajectory, trajectoryEventSchema } from '@kite-ai/trajectory';
import { expect, test } from '#kite-test';
import {
  loopModelLabel,
  loopPartSnippet,
  loopSystemPreparations,
} from '../src/desktop/trajectory/loop-materials';
import type { TrajectoryEvidenceView } from '../src/desktop/trajectory/TrajectoryPanel';
import { buildTrajectoryTree } from '../src/desktop/trajectory/tree';
import { buildTrajectoryWorkbenchIndex } from '../src/desktop/trajectory/workbench';
import { trajectoryRequestUserMessages } from '../src/desktop/trajectory/workbench-details';

function fixture(
  kind: 'system' | 'input' | 'thinking' | 'reply',
  data: unknown,
  status: TrajectoryEvidenceView['status'] = 'available',
) {
  const event = trajectoryEventSchema.parse({
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: `te_${'1'.repeat(64)}`,
    sequence: '1',
    origin: { storeId: 'store', cursor: '1' },
    sessionId: 's',
    workspaceId: 'w',
    runId: 'run',
    kind: 'model',
    executionId: 'm',
    phase: 'completed',
    sourceEventType: 'execution.finished',
    sourceRecordRevision: '1',
    recordedStatus: 'succeeded',
    occurredAt: 1,
    identityConfidence: 'verified_origin',
    attributes: {},
    evidenceRefs: [
      {
        kind: kind === 'system' || kind === 'input' ? 'model_input' : 'model_output',
        evidenceId: 'body',
        contentVersion: 'original-version',
        availability: 'available',
        mediaType: 'application/json',
      },
    ],
  });
  const projection = projectTrajectory([event], { atCursor: '1', completePrefix: true });
  const index = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
    loopParts: true,
  });
  const row = index.rows.find((row) => row.virtualPart?.kind === kind)!;
  const owner = index.rows.find((value) => value.id === row.virtualPart!.ownerId)!;
  const view: TrajectoryEvidenceView = {
    eventId: event.eventId,
    evidenceId: 'body',
    contentVersion: 'original-version',
    kind: event.evidenceRefs[0]!.kind,
    mediaType: 'application/json',
    status,
    data,
  };
  return { row, owner, view, snippet: () => loopPartSnippet(row, [view]) };
}

function preparationPair(secondData: unknown) {
  const data = {
    request: {
      messages: [{ role: 'system', content: 'Exact saved system instruction.' }],
      tools: [{ id: 'files.read', description: 'Read a file.', inputSchema: { type: 'object' } }],
    },
  };
  const first = fixture('system', data);
  const firstEvent = first.row.events[0]!;
  const secondEvent = trajectoryEventSchema.parse({
    ...firstEvent,
    eventId: `te_${'2'.repeat(64)}`,
    sequence: '2',
    origin: { storeId: 'store', cursor: '2' },
    executionId: 'm2',
    evidenceRefs: [{ ...firstEvent.evidenceRefs[0], evidenceId: 'body2', contentVersion: 'v2' }],
  });
  const projection = projectTrajectory([firstEvent, secondEvent], {
    atCursor: '2',
    completePrefix: true,
  });
  const index = buildTrajectoryWorkbenchIndex(projection, buildTrajectoryTree(projection, []), {
    loopParts: true,
  });
  const secondView: TrajectoryEvidenceView = {
    ...first.view,
    eventId: secondEvent.eventId,
    evidenceId: 'body2',
    contentVersion: 'v2',
    data: secondData,
  };
  return {
    rows: index.rows,
    views: [first.view, secondView],
    secondId: 'execution:m2:part:system',
    original: data,
  };
}

test('system reuse compares complete exact preparation while allowing actual request history to differ', () => {
  const f = preparationPair({
    request: {
      messages: [
        { role: 'system', content: 'Exact saved system instruction.' },
        { role: 'user', content: 'A later request with different history.' },
      ],
      tools: [{ inputSchema: { type: 'object' }, description: 'Read a file.', id: 'files.read' }],
      modelId: 'another-public-binding',
    },
  });
  const before = structuredClone(f.rows);
  expect(loopSystemPreparations(f.rows, f.views).get(f.secondId)).toBe('unchanged');
  expect(f.rows).toEqual(before);
  for (const change of [
    { messages: [{ role: 'system', content: 'Changed saved instruction.' }] },
    { tools: [{ id: 'files.read', description: 'Read a file.', inputSchema: { type: 'string' } }] },
    { tools: [] },
  ]) {
    f.views[1]!.data = { request: { ...f.original.request, ...change } };
    expect(loopSystemPreparations(f.rows, f.views).get(f.secondId)).toBe('changed');
  }
});

test('system reuse never guesses through missing, old, partial, oversized or another Run material', () => {
  const f = preparationPair({
    request: {
      messages: [{ role: 'system', content: 'Exact saved system instruction.' }],
      tools: [{ id: 'files.read', description: 'Read a file.', inputSchema: { type: 'object' } }],
    },
  });
  expect(loopSystemPreparations(f.rows, [f.views[1]!]).size).toBe(0);
  for (const status of ['loading', 'partial', 'truncated', 'unavailable', 'redacted'] as const) {
    expect(loopSystemPreparations(f.rows, [{ ...f.views[0]!, status }, f.views[1]!]).size).toBe(0);
  }
  expect(
    loopSystemPreparations(f.rows, [
      { ...f.views[0]!, contentVersion: 'foreign-version' },
      f.views[1]!,
    ]).size,
  ).toBe(0);
  const anotherRun = f.rows.map((row) =>
    row.id === 'execution:m2' ? { ...row, runKey: 'another-run' } : row,
  );
  expect(loopSystemPreparations(anotherRun, f.views).size).toBe(0);
  const owner = f.rows.find((row) => row.id === 'execution:m2')!;
  const intermediate = { ...owner, id: 'execution:unread-neighbor' };
  const withGap = f.rows.flatMap((row) => (row === owner ? [intermediate, row] : [row]));
  expect(loopSystemPreparations(withGap, f.views).size).toBe(0);
  expect(
    loopSystemPreparations(
      f.rows.map((row) =>
        row === owner
          ? { ...row, step: { ...row.step!, identityConfidence: 'legacy_local' } }
          : row,
      ),
      f.views,
    ).size,
  ).toBe(0);
  expect(
    loopSystemPreparations(
      f.rows.map((row) =>
        row.id === f.secondId
          ? {
              ...row,
              virtualPart: {
                ...row.virtualPart!,
                targets: row.virtualPart!.targets.map((target) => ({
                  ...target,
                  reference: { ...target.reference, availability: 'partial' },
                })),
              },
            }
          : row,
      ),
      f.views,
    ).size,
  ).toBe(0);
  for (const view of f.views)
    view.data = {
      request: {
        ...f.original.request,
        messages: [{ role: 'system', content: 'x'.repeat(600_000) }],
      },
    };
  expect(loopSystemPreparations(f.rows, f.views).size).toBe(0);
});

test('model names distinguish waiting, unreadable and genuinely absent saved metadata', () => {
  const f = fixture('input', {
    request: { modelId: 'opaque-binding' },
    metadata: {
      adapter: {
        availability: 'available',
        provider: { availability: 'available', modelId: 'actual-provider' },
      },
    },
  });
  expect(loopModelLabel(f.owner, [])).toBe('正在读取模型名称…');
  f.view.status = 'loading';
  expect(loopModelLabel(f.owner, [f.view])).toBe('正在读取模型名称…');
  f.view.status = 'unavailable';
  expect(loopModelLabel(f.owner, [f.view])).toBe('模型名称暂不可读');
  f.view.status = 'available';
  expect(loopModelLabel(f.owner, [f.view])).toBe('actual-provider');
  f.view.data = { request: { modelId: 'opaque-binding' }, metadata: {} };
  expect(loopModelLabel(f.owner, [f.view])).toBe('模型名称未保存');
});

test('17 MiB output excerpts stop at a grapheme-safe prefix without cutting combined emoji', () => {
  const prefix = `${'a'.repeat(159)}👩🏽‍💻`,
    large = `${prefix}${'z'.repeat(17 * 1024 * 1024)}`;
  expect(fixture('reply', { content: large }).snippet()).toBe(`${prefix}…`);
  expect(fixture('thinking', { reasoning: large }, 'partial').snippet()).toBe(
    `${prefix}… · 已保存前缀`,
  );
  expect(fixture('reply', { content: `${'e\u0301'.repeat(160)}more` }).snippet()).toBe(
    `${'e\u0301'.repeat(160)}…`,
  );
});

test('system and user snippets consume matching message prefixes lazily rather than joining all stored bodies', () => {
  const later = {
    role: 'system',
    get content(): string {
      throw Error('later_body_must_not_be_read');
    },
  };
  const large = '系'.repeat(17 * 1024 * 1024);
  expect(
    fixture('system', {
      request: { messages: [{ role: 'system', content: large }, later] },
    }).snippet(),
  ).toBe(`${'系'.repeat(160)}…`);
  expect(
    fixture('input', {
      request: {
        messages: [
          { role: 'user', content: large },
          {
            role: 'user',
            get content(): string {
              throw Error('later_user_body_must_not_be_read');
            },
          },
        ],
      },
    }).snippet(),
  ).toBe(`${'系'.repeat(160)}…`);
});

test('message segments normalize whitespace and remain bounded across original role boundaries without borrowing private fields', () => {
  const request = {
    privatePrompt: 'PRIVATE_PROMPT',
    messages: [
      { role: 'assistant', content: 'NOT_SYSTEM', reasoning: 'PRIVATE_THOUGHT' },
      { role: 'system', content: '  系统\n 指令  ', privateText: 'PRIVATE_SYSTEM' },
      { role: 'developer', content: '开发者\t约束' },
      { role: 'system', content: '后续\t系统指令' },
      { role: 'user', content: '用户\n 请求', reasoning: 'PRIVATE_USER' },
    ],
  };
  expect(fixture('system', { request }).snippet()).toBe('系统 指令 · 后续 系统指令');
  expect(fixture('input', { request }).snippet()).toBe('用户 请求');
  expect(
    fixture('thinking', { content: 'reply', privateReasoning: 'PRIVATE_THOUGHT' }).snippet(),
  ).toBe('未保存可展示的思考');
  expect(
    fixture('reply', { reasoning: 'NOT_REPLY', privateContent: 'PRIVATE_REPLY' }).snippet(),
  ).toBe('本次输出没有文本');
});

test('empty, unavailable and mismatched observations keep their original explicit states', () => {
  expect(
    fixture('system', { request: { messages: [{ role: 'system', content: ' \n ' }] } }).snippet(),
  ).toBe('原请求未含系统提示词');
  expect(fixture('input', { request: { messages: [] } }).snippet()).toBe('原请求未含用户文本');
  expect(fixture('reply', { content: '', toolCalls: [{ id: 'planned' }] }).snippet()).toBe(
    '发起 1 个工具调用，没有单独文本',
  );
  const unavailable = fixture('reply', { content: 'NEVER_SHOW' }, 'unavailable');
  expect(unavailable.snippet()).toBe('此版本内容当前不可读取');
  const old = fixture('reply', { content: 'FUTURE_BODY' });
  old.view.contentVersion = 'different-version';
  expect(old.snippet()).toBe('已保存输出尚未读取');
});

test('user context omits only the current captured session-files occurrence and content-free blocks', () => {
  const id = 'session-output:session-files:s';
  const content = '{"kind":"session_files","files":[],"outputDirectory":"/saved/outputs"}';
  const historyCopy = { role: 'user', content, sourceIds: [id] };
  const pasted = { role: 'user', content };
  const image = { role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'saved' }] };
  const call = { role: 'user', content: '', toolCalls: [{ id: 'saved-call' }] };
  const messages: Record<string, unknown>[] = [
    { role: 'user', content: '你好' },
    historyCopy,
    pasted,
    { role: 'user', content: '' },
    { role: 'user', content: ' \n\t' },
    image,
    call,
    { role: 'user', content, sourceIds: [id] },
    { role: 'user', content: '', sourceIds: ['runtime.kernel:s'] },
  ];
  const data = {
    request: { messages, tools: [] },
    metadata: {
      context: {
        transformationId: 'kite.model-request',
        transformationVersion: '2',
        messageOrder: 'request.messages',
        sourceOrder: 'request.messages[].sourceIds',
        sources: [{ id, digest: 'captured-digest' }],
      },
    },
  };
  const original = structuredClone(data);
  const f = fixture('input', data);
  const event = f.row.virtualPart!.targets[0]!.event;
  const shown = () => [...trajectoryRequestUserMessages(data, { event, complete: true })];
  expect(shown()).toEqual([messages[0]!, historyCopy, pasted, image, call]);
  expect(data).toEqual(original);
  expect(f.snippet()).toBe(`你好 · ${content} · ${content}`);
  // If the user sent only an image, the host's private directory cannot become the list excerpt.
  messages.splice(0, messages.length, image, { role: 'user', content, sourceIds: [id] });
  expect(shown()).toEqual([image]);
  expect(f.snippet()).toBe('原请求未含用户文本');
});

test('incomplete, legacy, foreign or unmarked context is preserved rather than guessed from JSON text', () => {
  const id = 'host:session-files:s';
  const message = { role: 'user', content: '{"kind":"session_files"}', sourceIds: [id] };
  const context = {
    transformationId: 'kite.model-request',
    transformationVersion: '2',
    messageOrder: 'request.messages',
    sourceOrder: 'request.messages[].sourceIds',
    sources: [{ id, digest: 'captured-digest' }],
  };
  const data = { request: { messages: [message], tools: [] }, metadata: { context } };
  const f = fixture('input', data);
  const event = f.row.virtualPart!.targets[0]!.event;
  expect([...trajectoryRequestUserMessages(data, { event, complete: true })]).toEqual([]);
  expect([...trajectoryRequestUserMessages(data)]).toEqual([message]);
  expect([...trajectoryRequestUserMessages(data, { event, complete: false })]).toEqual([message]);
  for (const other of [
    { ...event, sessionId: 'other-session' },
    { ...event, identityConfidence: 'legacy_local' as const },
  ])
    expect([...trajectoryRequestUserMessages(data, { event: other, complete: true })]).toEqual([
      message,
    ]);
  for (const change of [
    { transformationId: 'unknown' },
    { transformationVersion: 'future' },
    { messageOrder: 'unknown' },
    { sourceOrder: 'unknown' },
    { sources: [] },
    { sources: [{ id: 'host:session-files:other-session', digest: 'other' }] },
  ])
    expect([
      ...trajectoryRequestUserMessages(
        { ...data, metadata: { context: { ...context, ...change } } },
        { event, complete: true },
      ),
    ]).toEqual([message]);
  for (const sourceIds of [[], ['unmarked'], [id, 'another-source']])
    expect([
      ...trajectoryRequestUserMessages(
        { ...data, request: { messages: [{ ...message, sourceIds }], tools: [] } },
        { event, complete: true },
      ),
    ]).toEqual([{ ...message, sourceIds }]);
  for (const status of ['partial', 'truncated'] as const) {
    f.view.status = status;
    expect(f.snippet()).toContain(message.content);
  }
});

test('only the current captured Planning runtime occurrence is omitted; earlier history and pasted runtime text remain', () => {
  const id = 'builtin.planning:runtime:run';
  const content = '<runtime-state source="runtime.kernel">x</runtime-state>';
  const history = { role: 'user', content, sourceIds: [id] };
  const pasted = { role: 'user', content };
  const image = { role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'saved' }] };
  const data = {
    request: {
      messages: [
        { role: 'user', content: '你好' },
        history,
        pasted,
        image,
        { role: 'user', content, sourceIds: [id] },
      ],
      tools: [],
    },
    metadata: {
      context: {
        transformationId: 'kite.model-request',
        transformationVersion: '2',
        messageOrder: 'request.messages',
        sourceOrder: 'request.messages[].sourceIds',
        sources: [{ id, digest: 'saved-runtime-digest' }],
      },
    },
  };
  const f = fixture('input', data);
  const event = f.row.virtualPart!.targets[0]!.event;
  const original = structuredClone(data);
  expect([...trajectoryRequestUserMessages(data, { event, complete: true })]).toEqual(
    data.request.messages.slice(0, -1),
  );
  expect(f.snippet()).toBe(`你好 · ${content} · ${content}`);
  expect(data).toEqual(original);
  for (const other of [
    { ...event, runId: 'other-run' },
    { ...event, runId: undefined },
    { ...event, identityConfidence: 'legacy_local' as const },
  ])
    expect([...trajectoryRequestUserMessages(data, { event: other, complete: true })]).toEqual(
      data.request.messages,
    );
  expect([...trajectoryRequestUserMessages(data, { event, complete: false })]).toEqual(
    data.request.messages,
  );
  const noSource = { ...data, metadata: { context: { ...data.metadata.context, sources: [] } } };
  expect([...trajectoryRequestUserMessages(noSource, { event, complete: true })]).toEqual(
    data.request.messages,
  );
  for (const status of ['partial', 'truncated'] as const) {
    f.view.status = status;
    const reduced = {
      ...data,
      request: { messages: [{ role: 'user', content, sourceIds: [id] }], tools: [] },
    };
    f.view.data = reduced;
    expect(f.snippet()).toBe(`${content} · 已保存前缀`);
  }
});
