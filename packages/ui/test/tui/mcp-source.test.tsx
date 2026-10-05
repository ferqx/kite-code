import { expect, test } from 'bun:test';
import type { Interaction, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiMcpSourceApprovalIntent,
  type TuiMcpSourceApprovalOutcome,
  type TuiMcpSourceSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';
import { isMcpSourceQuestion } from '../../src/tui/mcp-source-question';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const serverId = `mcp-${'a'.repeat(64)}`;
const sourceSnapshot = (sessionId = 'a'): TuiMcpSourceSnapshot => ({
  storeId: 'store',
  sessionId,
  workspaceId: 'w',
  workspaceIdentity: 'physical-w',
  registryRevision: 'r',
  errors: [],
  readSet: {
    scopeDigest: '1'.repeat(64),
    user: {
      identity: { kind: 'user', pathDigest: '2'.repeat(64), rootIdentity: '3'.repeat(64) },
      etag: null,
      error: null,
    },
    workspace: {
      identity: { kind: 'workspace', pathDigest: '4'.repeat(64), rootIdentity: '5'.repeat(64) },
      etag: null,
      error: null,
    },
    approvalEtag: null,
    bindingEtag: null,
    variablesDigest: '6'.repeat(64),
  },
  items: [
    {
      id: serverId,
      name: '原项目名称',
      source: { kind: 'workspace', pathDigest: '4'.repeat(64), rootIdentity: '5'.repeat(64) },
      rawEntryDigest: '7'.repeat(64),
      transportDigest: '8'.repeat(64),
      transport: 'http',
      enabled: false,
      admitted: false,
      reason: 'mcp_source_rejected',
      configDigest: null,
    },
  ],
});
const original = (id: string, store = 'store', sessionId = 'old'): TuiMcpSourceApprovalIntent => ({
  sessionId,
  workspaceId: 'w',
  workspaceIdentity: 'original-physical-w',
  request: {
    expectedStoreId: store,
    commandId: id,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp.sources',
    actionId: 'mcp.source.approve',
    definitionVersion: '1',
    input: { serverId, expectedReadSet: sourceSnapshot().readSet! },
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value: T) => resolve(value),
  };
}
function fixture(saved: TuiMcpSourceApprovalOutcome[] = []) {
  let minted = 0,
    business = 0,
    workspaceId = 'w',
    cards: Interaction[] = [];
  const sent: { intent: TuiMcpSourceApprovalIntent; observed: TuiMcpSourceSnapshot }[] = [],
    lookups: TuiMcpSourceApprovalIntent[] = [],
    signals: AbortSignal[] = [],
    answers: unknown[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `source-${++minted}`,
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, workspaceId },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [],
      interactions: cards,
    }),
    submit: async () => {
      business++;
      throw Error('unexpected Run');
    },
    getCommand: async () => {
      business++;
      throw Error('unexpected GET');
    },
    cancel: async () => {
      business++;
      throw Error('unexpected cancel');
    },
    answer: async (id, card, request) => {
      answers.push({ id, card, request });
      return {
        id: request.commandId,
        sessionId: id,
        kind: 'interaction.answer',
        originStoreId: 'store',
        status: 'applied',
        receipt: {
          outcome: 'answer_saved',
          interactionId: card,
          decisionRevision: (BigInt(request.expectedRevision) + 1n).toString(),
        },
        cancelRequestedAt: null,
      };
    },
    mcp: {
      read: async () => {
        throw Error('management unavailable');
      },
      submit: async () => {
        business++;
        throw Error('unexpected selection');
      },
      lookup: async () => {
        business++;
        throw Error('unexpected selection GET');
      },
      source: {
        read: async (id) => ({ ...sourceSnapshot(id), workspaceId }),
        list: async () => saved,
        submit: async (intent, observed) => {
          sent.push({ intent, observed });
          return { intent, phase: 'pending' };
        },
        lookup: async (intent, signal) => {
          lookups.push(intent);
          signals.push(signal);
          return { intent, phase: 'outcome_unknown' };
        },
      },
    },
  };
  return {
    port,
    controller: new TuiController(port),
    sent,
    lookups,
    signals,
    answers,
    counts: () => ({ minted, business }),
    cards: (value: Interaction[]) => {
      cards = value;
    },
    workspace: (value: string) => {
      workspaceId = value;
    },
  };
}
async function open(f: ReturnType<typeof fixture>) {
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.openMcpSources();
}
const question = (revision = '1'): Interaction => ({
  id: 'question',
  originStoreId: 'store',
  sessionId: 'a',
  presentationSessionId: 'a',
  ancestry: ['a'],
  runId: null,
  executionId: 'source-action',
  attempt: 1,
  kind: 'question',
  definitionId: 'builtin.mcp.sources/mcp.source.approve',
  definitionVersion: '1',
  inputDigest: 'digest',
  policyRevision: 'policy',
  requiredRefs: [],
  request: {
    kind: 'mcp_source_approval',
    executionId: 'source-action',
    originalStoreId: 'store',
    sessionId: 'a',
    choices: ['approved', 'rejected', 'cancel'],
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      properties: { decision: { type: 'string', enum: ['approved', 'rejected', 'cancel'] } },
    },
  },
  answer: null,
  revision,
  acceptedDecisionRevision: null,
  state: 'pending',
});

test('Ink independent Project sources remains visible on failed management; separate confirmation never answers Question', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('› Project sources');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Source list ready');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('› Review project source');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm project source review:');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.observed).toBe(f.controller.state.mcpSource!.facts!);
    expect(f.sent[0]!.intent.request.input.expectedReadSet).toEqual(sourceSnapshot().readSet!);
    expect(f.answers).toHaveLength(0);
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
    expect(ui.lastFrame()).toContain('Waiting for original source decision');
    ui.stdin.write('\u0003');
    await tick();
    expect(f.controller.state.panel).toBeUndefined();
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 5000);
for (const admitted of [false, true])
  test(`disabled project admitted=${admitted} remains reviewable; user or missing binding not reviewable`, async () => {
    const f = fixture();
    f.port.mcp!.source!.read = async () => {
      const s = sourceSnapshot();
      s.items = [{ ...s.items[0]!, admitted }];
      return s;
    };
    await open(f);
    await f.controller.requestMcpSourceApproval(serverId);
    expect(f.sent).toHaveLength(1);
    f.controller.dispose();
    const g = fixture();
    for (const change of [
      {
        source: { kind: 'user' as const, pathDigest: '4'.repeat(64), rootIdentity: '5'.repeat(64) },
      },
      { transportDigest: null },
      { transport: null },
      {
        source: {
          kind: 'workspace' as const,
          pathDigest: 'different',
          rootIdentity: '5'.repeat(64),
        },
      },
    ]) {
      g.port.mcp!.source!.read = async () => {
        const s = sourceSnapshot();
        s.items = [{ ...s.items[0]!, ...change }];
        return s;
      };
      await open(g);
      await g.controller.requestMcpSourceApproval(serverId);
    }
    expect(g.counts()).toEqual({ minted: 0, business: 0 });
    expect(g.sent).toHaveLength(0);
    g.controller.dispose();
  });
for (const failed of [false, true])
  test(`cross-Session original IDs in ${failed ? 'failed' : 'empty'} Source snapshot are pure selection, explicit Check only`, async () => {
    const f = fixture([
      { intent: original('first'), phase: 'outcome_unknown' },
      { intent: original('second', 'foreign'), phase: 'saved' },
    ]);
    f.port.mcp!.source!.read = async () => {
      if (failed) throw Error('physical workspace removed');
      return { ...sourceSnapshot(), items: [] };
    };
    await open(f);
    expect(f.lookups).toHaveLength(0);
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      ui.stdin.write('\u001b[B'.repeat(2));
      await tick();
      expect(ui.lastFrame()).toContain('› Original source decision: second');
      ui.stdin.write('\r');
      await tick();
      expect(f.lookups).toHaveLength(0);
      expect(f.controller.state.sessionId).toBe('a');
      expect(f.controller.state.mcpSourceOutcome!.intent.sessionId).toBe('old');
      expect(ui.lastFrame()).toContain('Original Store: foreign');
      expect(ui.lastFrame()).toContain('Source outcome unknown; check original');
      ui.stdin.write('\u001b[A'.repeat(2));
      await tick();
      ui.stdin.write('\r');
      await tick();
      expect(
        f.lookups.map((x) => [x.sessionId, x.request.commandId, x.request.expectedStoreId]),
      ).toEqual([['old', 'second', 'foreign']]);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  }, 5000);
test('current Store/Workspace/Server unknown conflicts across Sessions; foreign does not block new request', async () => {
  const f = fixture([{ intent: original('pending'), phase: 'pending' }]);
  await open(f);
  await f.controller.requestMcpSourceApproval(serverId);
  await f.controller.select('b');
  await f.controller.openMcpSources();
  await f.controller.requestMcpSourceApproval(serverId);
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.error).toBe('mcp_original_source_required');
  f.controller.dispose();
  const g = fixture([{ intent: original('foreign', 'foreign'), phase: 'outcome_unknown' }]);
  await open(g);
  await g.controller.requestMcpSourceApproval(serverId);
  expect(g.sent).toHaveLength(1);
  g.controller.dispose();
});
test('stale confirmation, duplicate journal and capacity fail closed before command mint', async () => {
  const f = fixture();
  await open(f);
  const observed = f.controller.state.mcpSource!.facts!;
  await f.controller.openMcpSources();
  await f.controller.requestMcpSourceApproval(serverId, observed);
  expect(f.sent).toHaveLength(0);
  f.port.mcp!.source!.list = async () => [
    { intent: original('same'), phase: 'saved' },
    { intent: original('same'), phase: 'saved' },
  ];
  await f.controller.requestMcpSourceApproval(serverId);
  expect(f.counts().minted).toBe(0);
  f.port.mcp!.source!.list = async () =>
    Array.from({ length: 129 }, (_, i) => ({
      intent: original(String(i)),
      phase: 'saved' as const,
    }));
  await f.controller.requestMcpSourceApproval(serverId);
  expect(f.sent).toHaveLength(0);
  f.controller.dispose();
});
test('late submit belongs to original saved record, never later selection; close releases no business', async () => {
  const f = fixture([{ intent: original('second'), phase: 'saved' }]);
  const d = deferred<TuiMcpSourceApprovalOutcome>();
  f.port.mcp!.source!.submit = async (intent, observed) => {
    f.sent.push({ intent, observed });
    return d.promise;
  };
  await open(f);
  const work = f.controller.requestMcpSourceApproval(serverId);
  await tick();
  f.controller.selectMcpSourceOriginal('second');
  d.resolve({ intent: f.sent[0]!.intent, phase: 'pending' });
  await work;
  expect(f.controller.state.mcpSourceOutcome!.intent.request.commandId).toBe('second');
  expect(
    f.controller.state.mcpSourceSaved!.find((row) => row.intent.request.commandId === 'source-1')!
      .phase,
  ).toBe('pending');
  f.controller.closePanel();
  expect(f.counts().business).toBe(0);
  f.controller.dispose();
});
for (const stop of ['back', 'close', 'session', 'dispose'] as const)
  test(`source lookup ${stop} aborts own reader; late result no scope overwrite`, async () => {
    const f = fixture([{ intent: original('first'), phase: 'outcome_unknown' }]);
    const d = deferred<TuiMcpSourceApprovalOutcome>();
    f.port.mcp!.source!.lookup = async (intent, signal) => {
      f.lookups.push(intent);
      f.signals.push(signal);
      return d.promise;
    };
    await open(f);
    const work = f.controller.lookupMcpSourceApproval();
    await tick();
    if (stop === 'back') f.controller.closeMcpSources();
    if (stop === 'close') f.controller.closePanel();
    if (stop === 'session') await f.controller.select('b');
    if (stop === 'dispose') f.controller.dispose();
    d.resolve({ intent: original('first'), phase: 'saved' });
    await work;
    expect(f.signals[0]!.aborted).toBe(true);
    expect(f.controller.state.mcpSourceSaved![0]!.phase).toBe('outcome_unknown');
    expect(f.counts().business).toBe(0);
    f.controller.dispose();
  });
test('Ink finite local source pagination reaches row beyond management 32 items without rendering whole list', async () => {
  const f = fixture();
  f.port.mcp!.source!.read = async () => {
    const s = sourceSnapshot();
    s.items = Array.from({ length: 61 }, (_, i) => ({
      ...s.items[0]!,
      id: `mcp-${i.toString(16).padStart(64, '0')}`,
      name: `external-${i}`,
    }));
    return s;
  };
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).not.toContain('external-60');
    ui.stdin.write('\u001b[B'.repeat(25));
    await tick();
    expect(ui.lastFrame()).toContain('› Next project sources');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('external-25');
    ui.stdin.write('\u001b[B'.repeat(26));
    await tick();
    expect(ui.lastFrame()).toContain('› Next project sources');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('external-50');
    expect(f.sent).toHaveLength(0);
    expect(f.lookups).toHaveLength(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 5000);
for (const [steps, decision] of [
  [1, 'approved'],
  [2, 'rejected'],
  [3, 'cancel'],
] as const)
  test(`Ink Source Question starts unselected; explicit ${decision} keeps original card/revision and never grants Action`, async () => {
    const f = fixture();
    f.cards([question()]);
    await f.controller.select('a');
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      expect(ui.lastFrame()).toContain(
        'Up/Down explicit source decision: none (Enter has no answer)',
      );
      ui.stdin.write('\r');
      await tick();
      expect(f.answers).toHaveLength(0);
      expect(f.counts().minted).toBe(0);
      ui.stdin.write('\u001b[B'.repeat(steps));
      await tick();
      expect(ui.lastFrame()).toContain(`Up/Down explicit source decision: ${decision}`);
      ui.stdin.write('\r');
      await tick();
      expect(f.answers).toHaveLength(1);
      expect(f.answers[0]).toMatchObject({
        id: 'a',
        card: 'question',
        request: {
          expectedStoreId: 'store',
          expectedRevision: '1',
          answer: { kind: 'question', answers: { decision } },
        },
      });
      expect(f.sent).toHaveLength(0);
      expect(f.counts().business).toBe(0);
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  }, 5000);
test('Source Question choice cannot cross revision or source/presentation identity; ordinary JSON Question and Ask unchanged', async () => {
  const f = fixture();
  f.cards([question()]);
  await f.controller.select('a');
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    f.cards([question('2')]);
    await f.controller.select('a');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    ui.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    ui.stdin.write('\u001b[B');
    await tick();
    const child = {
      ...question('2'),
      sessionId: 'child',
      request: { ...(question('2').request as object), sessionId: 'child' },
    } as Interaction;
    f.cards([child]);
    await f.controller.select('a');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    ui.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    ui.stdin.write('\u001b[B');
    await tick();
    const presented = { ...question('2'), presentationSessionId: 'b' };
    f.cards([presented]);
    await f.controller.select('b');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    ui.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    f.cards([question('2')]);
    await f.controller.select('a');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    f.cards([{ ...question('3'), definitionId: 'ordinary.question' }]);
    await f.controller.select('a');
    await tick();
    expect(ui.lastFrame()).not.toContain('Up/Down explicit source decision:');
    ui.stdin.write('{"decision":"rejected"}');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]).toMatchObject({
      request: { answer: { kind: 'question', answers: { decision: 'rejected' } } },
    });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 5000);
test('enum navigation admits only exact Source Action, closed schema and ordered choices', () => {
  expect(isMcpSourceQuestion(question())).toBe(true);
  const drifts: Partial<Interaction>[] = [
    { definitionId: 'builtin.mcp.sources/other' },
    { definitionVersion: '2' },
    { kind: 'approval' as const },
    { request: { ...(question().request as object), kind: 'mcp_credential_binding' } },
    { request: { ...(question().request as object), choices: ['rejected', 'approved', 'cancel'] } },
    {
      request: {
        ...(question().request as object),
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { type: 'string', enum: ['approved', 'rejected', 'cancel'] } },
          extra: true,
        },
      },
    },
    { request: { ...(question().request as object), executionId: 'other' } },
    { request: { ...(question().request as object), originalStoreId: 'foreign' } },
  ];
  for (const field of drifts) expect(isMcpSourceQuestion({ ...question(), ...field })).toBe(false);
});
test('late Source directory response after close is discarded; own signal aborted and no mutation', async () => {
  const f = fixture();
  const d = deferred<TuiMcpSourceSnapshot>();
  f.port.mcp!.source!.read = async (_id, signal) => {
    f.signals.push(signal);
    return d.promise;
  };
  await f.controller.select('a');
  const work = f.controller.openMcpSources();
  await tick();
  f.controller.closePanel();
  d.resolve(sourceSnapshot());
  await work;
  expect(f.signals[0]!.aborted).toBe(true);
  expect(f.controller.state.panel).toBeUndefined();
  expect(f.controller.state.mcpSource!.facts).toBeUndefined();
  expect(f.counts()).toEqual({ minted: 0, business: 0 });
  f.controller.dispose();
});
test('Ink Chinese Source labels preserve external name and original IDs', async () => {
  const f = fixture();
  f.port.preferences = {
    read: async () => ({
      revision: 'a'.repeat(64),
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN',
      colorPreset: 'teal',
      theme: 'dark',
    }),
    save: async () => {
      throw Error('unexpected preferences write');
    },
  };
  await f.controller.refreshPreferences();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('项目来源');
    expect(ui.lastFrame()).toContain('原项目名称');
    expect(ui.lastFrame()).toContain(serverId);
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('› 审查项目来源');
    expect(f.counts()).toEqual({ minted: 0, business: 0 });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 5000);
test('exact Source Question Esc/Ctrl+C clear only this explicit selection and never answer or cancel business', async () => {
  const f = fixture();
  f.cards([question()]);
  await f.controller.select('a');
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    expect(ui.lastFrame()).toContain('Up/Down explicit source decision: approved');
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    ui.stdin.write('\r');
    await tick();
    expect(f.answers).toHaveLength(0);
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\u0003');
    await tick();
    expect(ui.lastFrame()).toContain(
      'Up/Down explicit source decision: none (Enter has no answer)',
    );
    expect(f.answers).toHaveLength(0);
    expect(f.counts()).toEqual({ minted: 0, business: 0 });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
}, 5000);
for (const phase of ['saved', 'failed', 'cancelled'] as const)
  test(`journal-only ${phase} never claims a verified terminal source decision`, async () => {
    const f = fixture([{ intent: original('terminal'), phase }]);
    await open(f);
    f.controller.selectMcpSourceOriginal('terminal');
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      expect(ui.lastFrame()).toContain('Source outcome unknown; check original');
      expect(f.lookups).toHaveLength(0);
      expect(f.sent).toHaveLength(0);
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  }, 5000);
