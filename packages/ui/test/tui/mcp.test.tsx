import { expect, test } from 'bun:test';
import type { QueryResponse, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  decodeTuiMcpSnapshot,
  TuiController,
  type TuiMcpIntent,
  type TuiMcpOutcome,
  type TuiMcpSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

const workspace = (sessionId: string) =>
  sessionId.startsWith('isolated-')
    ? `w-${sessionId}`
    : sessionId === 'foreign'
      ? 'other-workspace'
      : 'w';
const observed = (sessionId = 'a'): TuiMcpSnapshot => ({
  storeId: 'store',
  sessionId,
  workspaceId: workspace(sessionId),
  workspaceIdentity: `file:///owned/${workspace(sessionId)}`,
  workspacePath: `/owned/${workspace(sessionId)}`,
  registryRevision: 'registry-1',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: 'b'.repeat(64),
    explicitDigest: 'c'.repeat(64),
    registryDigest: 'd'.repeat(64),
    registryRevision: 'registry-1',
    scopeDigest: 'e'.repeat(64),
  },
  items: Array.from({ length: 32 }, (_, index) => ({
    id:
      index === 0
        ? 'refresh'
        : index === 1
          ? 'user'
          : `server-${index.toString().padStart(2, '0')}`,
    configDigest: 'f'.repeat(64),
    transport: index % 2 ? 'http' : 'stdio',
    source: { kind: 'programmatic', id: `source-${index}`, revision: '1' },
    admitted: true,
    selected: false,
    available: false,
    reason: 'not_connected',
  })),
});
const query = (facts = observed()): QueryResponse =>
  [
    {
      extensionId: 'builtin.mcp.management',
      contentType: 'builtin.mcp.servers',
      contentVersion: 1,
      summary: 'all 32 original Servers',
      payload: facts,
      artifactRefs: [],
      actions: [],
    },
  ] as unknown as QueryResponse;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value: T) => resolve(value),
  };
}
function fixture() {
  let sequence = 0,
    reads = 0,
    work = 0,
    answers = 0,
    cancels = 0,
    commands = 0;
  const sent: TuiMcpIntent[] = [],
    lookups: TuiMcpIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `mcp-${++sequence}`,
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, rootSessionId: id, parentSessionId: null, workspaceId: workspace(id) },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [],
      interactions: [],
    }),
    submit: async () => {
      work++;
      throw Error('unexpected work');
    },
    answer: async () => {
      answers++;
      throw Error('unexpected answer');
    },
    cancel: async () => {
      cancels++;
      throw Error('unexpected cancel');
    },
    getCommand: async () => {
      commands++;
      throw Error('unexpected business lookup');
    },
    mcp: {
      read: async (id) => {
        reads++;
        return decodeTuiMcpSnapshot(query(observed(id)));
      },
      submit: async (intent) => {
        sent.push(intent);
        return { intent, phase: 'outcome_unknown' };
      },
      lookup: async (intent) => {
        lookups.push(intent);
        return { intent, phase: 'outcome_unknown' };
      },
    },
  };
  return {
    port,
    sent,
    lookups,
    controller: new TuiController(port),
    counts: () => ({ reads, work, answers, cancels, commands, identities: sequence }),
  };
}
const noWork = (f: ReturnType<typeof fixture>) => {
  expect(f.counts().work).toBe(0);
  expect(f.counts().answers).toBe(0);
  expect(f.counts().cancels).toBe(0);
  expect(f.counts().commands).toBe(0);
};

test('fixed Query decodes all 32 Servers with immutable complete read set and no aliases', () => {
  const wire = query(),
    facts = decodeTuiMcpSnapshot(wire);
  expect(facts).toEqual(observed());
  expect(facts.items).toHaveLength(32);
  expect(facts.items.at(-1)!.id).toBe('server-31');
  (wire[0]!.payload as unknown as TuiMcpSnapshot).readSet.userEtag = '0'.repeat(64);
  expect(facts.readSet.userEtag).toBe('a'.repeat(64));
});
test('strict Query rejects malformed shape, duplicates, future fields, bad read set hash and capacity without partial list', () => {
  type Row = Record<string, unknown>;
  const malformed: Array<(payload: Row, display: Row) => void> = [
    (p) => {
      p.future = true;
    },
    (p) => {
      delete p.workspaceIdentity;
    },
    (p) => {
      p.items = [...observed().items, { ...observed().items[0]!, id: 'server-32' }];
    },
    (p) => {
      p.items = [observed().items[0], observed().items[0]];
    },
    (p) => {
      (p.items as Row[])[0]!.future = true;
    },
    (p) => {
      ((p.items as Row[])[0]!.source as Row).future = true;
    },
    (p) => {
      (p.readSet as Row).future = true;
    },
    (p) => {
      (p.readSet as Row).userEtag = 'not-a-hash';
    },
    (p) => {
      (p.readSet as Row).workspaceEtag = 'g'.repeat(64);
    },
    (p) => {
      (p.readSet as Row).explicitDigest = 'a'.repeat(63);
    },
    (p) => {
      (p.readSet as Row).registryDigest = 'A'.repeat(64);
    },
    (p) => {
      (p.readSet as Row).scopeDigest = 'e'.repeat(65);
    },
    (p) => {
      (p.readSet as Row).registryRevision = 'other';
    },
    (p) => {
      (p.items as Row[])[0]!.id = 'invalid server';
    },
    (p) => {
      (p.items as Row[])[0]!.transport = 'future';
    },
    (p) => {
      (p.items as Row[])[0]!.transport = ['http'];
    },
    (p) => {
      (p.items as Row[])[0]!.selected = 'true';
    },
    (p) => {
      (p.items as Row[])[0]!.configDigest = 'invalid';
    },
    (p) => {
      ((p.items as Row[])[0]!.source as Row).kind = 'future';
    },
    (p) => {
      ((p.items as Row[])[0]!.source as Row).kind = ['user'];
    },
    (p) => {
      ((p.items as Row[])[0]!.source as Row).revision = '';
    },
    (p) => {
      (p.items as Row[])[0]!.reason = 0;
    },
    (_p, d) => {
      d.extensionId = 'other';
    },
    (_p, d) => {
      d.contentType = 'other';
    },
    (_p, d) => {
      d.contentVersion = 2;
    },
    (_p, d) => {
      d.actions = [{}];
    },
    (_p, d) => {
      d.artifactRefs = [{}];
    },
    (_p, d) => {
      d.future = true;
    },
    (_p, d) => {
      delete d.summary;
    },
    (_p, d) => {
      d.summary = 123;
    },
    (_p, d) => {
      d.actions = { length: 0 };
    },
    (_p, d) => {
      d.artifactRefs = '';
    },
  ];
  for (const mutate of malformed) {
    const wire = query(),
      display = wire[0] as unknown as Row;
    mutate(display.payload as Row, display);
    expect(() => decodeTuiMcpSnapshot(wire)).toThrow();
  }
  expect(() => decodeTuiMcpSnapshot([])).toThrow();
  expect(() =>
    decodeTuiMcpSnapshot({ 0: query()[0], length: 1 } as unknown as QueryResponse),
  ).toThrow();
  expect(() => decodeTuiMcpSnapshot([...query(), ...query()])).toThrow();
  expect(
    decodeTuiMcpSnapshot(
      query({ ...observed(), items: [], readSet: { ...observed().readSet, workspaceEtag: null } }),
    ).items,
  ).toEqual([]);
});
test('actual Ink navigation reaches Server 32 and refresh/user IDs remain Server choices; only reviewed Enter submits', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('› refresh ·');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Server: refresh');
    expect(f.counts().reads).toBe(1);
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b');
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Server: user');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b');
    await tick();
    ui.stdin.write('\u001b[B'.repeat(31));
    await tick();
    expect(ui.lastFrame()).toContain('› server-31 ·');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Server: server-31');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('r');
    ui.stdin.write('a');
    ui.stdin.write('d');
    ui.stdin.write(' ');
    await tick();
    expect(f.counts().reads).toBe(1);
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm server change: server-31');
    expect(ui.lastFrame()).toContain('User settings');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b');
    await tick();
    expect(ui.lastFrame()).not.toContain('Confirm server change:');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Project settings');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.request.input).toEqual({
      serverId: 'server-31',
      enabled: true,
      scope: 'workspace',
      expectedReadSet: observed().readSet,
    });
    expect(f.controller.state.mcpOutcome!.phase).toBe('outcome_unknown');
    ui.stdin.write('\u001b[B');
    await tick();
    expect(ui.lastFrame()).toContain('› Check original change');
    ui.stdin.write('\r');
    await tick();
    expect(f.lookups).toEqual([f.sent[0]!]);
    expect(f.sent).toHaveLength(1);
    noWork(f);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
test('Ink Ctrl+C aborts only the active directory read; late response cannot reopen panel or submit work', async () => {
  const f = fixture();
  await f.controller.select('a');
  const late = deferred<TuiMcpSnapshot>();
  let signal!: AbortSignal;
  f.port.mcp!.read = (_id, s) => {
    signal = s;
    return late.promise;
  };
  const opening = f.controller.openMcp(),
    ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Reading servers');
    ui.stdin.write('\u0003');
    await tick();
    expect(signal.aborted).toBe(true);
    expect(f.controller.state.panel).toBeUndefined();
    late.resolve(observed());
    await opening;
    expect(f.controller.state.mcp?.read).not.toBe('ready');
    expect(f.sent).toHaveLength(0);
    noWork(f);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
test('strict scope and unavailable read preserve last same-scope facts but deny all choices', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.routeCommand('/mcp extra');
  expect(f.controller.state.panel).toBeUndefined();
  await f.controller.routeCommand('/mcp');
  const original = f.controller.state.mcp!.facts!;
  f.port.mcp!.read = async () => {
    throw Error('owned_read_failure');
  };
  await f.controller.openMcp();
  expect(f.controller.state.mcp!.facts).toBe(original);
  expect(f.controller.state.mcp!.read).toBe('failed');
  await f.controller.chooseMcp('refresh', true, 'user', original);
  expect(f.sent).toHaveLength(0);
  for (const facts of [
    { ...observed(), storeId: 'other' },
    { ...observed(), sessionId: 'other' },
    { ...observed(), workspaceId: 'other' },
  ]) {
    f.port.mcp!.read = async () => facts;
    await f.controller.openMcp();
    expect(f.controller.state.error).toBe('mcp_directory_scope_mismatch');
    expect(f.controller.state.mcp!.facts).toBe(original);
    await f.controller.chooseMcp('refresh', true, 'workspace');
  }
  expect(f.sent).toHaveLength(0);
  noWork(f);
  f.controller.dispose();
});
test('stale observation, refreshed proof, unadmitted Server and absent workspace file grant zero writes', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const old = f.controller.state.mcp!.facts!;
  f.controller.observationUnavailable('lost');
  await f.controller.chooseMcp('refresh', true, 'user');
  expect(f.sent).toHaveLength(0);
  f.controller.observationReady('store');
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'user', old);
  expect(f.sent).toHaveLength(0);
  f.port.mcp!.read = async () => ({
    ...observed(),
    readSet: { ...observed().readSet, workspaceEtag: null },
    items: observed().items.map((item) => ({ ...item, admitted: false })),
  });
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'user');
  expect(f.controller.state.error).toBe('mcp_selection_unavailable');
  await f.controller.chooseMcp('refresh', true, 'workspace');
  f.port.mcp!.read = async () => ({
    ...observed(),
    readSet: { ...observed().readSet, workspaceEtag: null },
  });
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'workspace');
  expect(f.controller.state.error).toBe('mcp_selection_unavailable');
  expect(f.sent).toHaveLength(0);
  noWork(f);
  f.controller.dispose();
});
test('late directory reads after refresh, close, Session switch or dispose never overwrite current scope', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const late = deferred<TuiMcpSnapshot>();
  let signal!: AbortSignal;
  f.port.mcp!.read = (_id, s) => {
    signal = s;
    return late.promise;
  };
  const old = f.controller.openMcp();
  f.port.mcp!.read = async () => ({
    ...observed(),
    registryRevision: 'new',
    readSet: { ...observed().readSet, registryRevision: 'new' },
  });
  await f.controller.openMcp();
  expect(signal.aborted).toBe(true);
  late.resolve(observed());
  await old;
  expect(f.controller.state.mcp!.facts!.registryRevision).toBe('new');
  for (const change of ['close', 'switch', 'dispose']) {
    const d = deferred<TuiMcpSnapshot>();
    f.port.mcp!.read = (_id, s) => {
      signal = s;
      return d.promise;
    };
    const opening = f.controller.openMcp();
    if (change === 'close') f.controller.closePanel();
    else if (change === 'switch') await f.controller.select('foreign');
    else f.controller.dispose();
    expect(signal.aborted).toBe(true);
    d.resolve(observed());
    await opening;
    expect(f.controller.state.mcp?.facts?.sessionId).not.toBe('foreign');
    if (change === 'switch') expect(f.controller.state.mcp).toBeUndefined();
  }
  expect(f.sent).toHaveLength(0);
  noWork(f);
});
test('unknown freezes original body/read set; only original lookup runs and mismatched reply cannot confirm', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const facts = f.controller.state.mcp!.facts!;
  await f.controller.chooseMcp('refresh', true, 'workspace');
  const intent = f.sent[0]!;
  expect(Object.isFrozen(intent.request.input.expectedReadSet)).toBe(true);
  expect(intent.request.input.expectedReadSet).toEqual(facts.readSet);
  expect(intent.workspaceIdentity).toBe(facts.workspaceIdentity);
  await f.controller.chooseMcp('user', true, 'workspace');
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.error).toBe('mcp_original_outcome_required');
  f.port.mcp!.lookup = async (original) => {
    f.lookups.push(original);
    return { intent: { ...original, sessionId: 'foreign' }, phase: 'applied' };
  };
  await f.controller.lookupMcp();
  expect(f.controller.state.mcpOutcome!.phase).toBe('outcome_unknown');
  expect(f.lookups[0]).toBe(intent);
  expect(f.sent).toHaveLength(1);
  await f.controller.select('foreign');
  await f.controller.openMcp();
  await f.controller.lookupMcp();
  expect(f.lookups).toHaveLength(1);
  await f.controller.select('a');
  await f.controller.openMcp();
  expect(f.controller.state.mcpOutcome!.intent).toBe(intent);
  f.port.mcp!.lookup = async (original) => {
    f.lookups.push(original);
    return { intent: original, phase: 'failed' };
  };
  await f.controller.lookupMcp();
  expect(f.controller.state.mcpOutcome!.phase).toBe('failed');
  expect(f.controller.state.error).toBe('mcp_selection_failed');
  expect(f.lookups[1]).toBe(intent);
  expect(f.sent).toHaveLength(1);
  noWork(f);
  f.controller.dispose();
});
test('in-flight intent is shared; late submit and lookup replies preserve original scope after Session switch', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const reply = deferred<TuiMcpOutcome>();
  f.port.mcp!.submit = (intent) => {
    f.sent.push(intent);
    return reply.promise;
  };
  const writing = f.controller.chooseMcp('refresh', true, 'workspace');
  await f.controller.chooseMcp('user', true, 'workspace');
  expect(f.sent).toHaveLength(1);
  await f.controller.select('foreign');
  reply.resolve({ intent: f.sent[0]!, phase: 'outcome_unknown' });
  await writing;
  expect(f.controller.state.mcpOutcome).toBeUndefined();
  expect(f.controller.state.sessionId).toBe('foreign');
  await f.controller.select('a');
  await f.controller.openMcp();
  const lookup = deferred<TuiMcpOutcome>();
  let signal!: AbortSignal;
  f.port.mcp!.lookup = (intent, s) => {
    f.lookups.push(intent);
    signal = s;
    return lookup.promise;
  };
  const reading = f.controller.lookupMcp();
  await f.controller.select('foreign');
  expect(signal.aborted).toBe(true);
  lookup.resolve({ intent: f.sent[0]!, phase: 'failed' });
  await reading;
  expect(f.controller.state.mcpOutcome).toBeUndefined();
  await f.controller.select('a');
  await f.controller.openMcp();
  expect(f.controller.state.mcpOutcome!.phase).toBe('outcome_unknown');
  expect(f.sent).toHaveLength(1);
  noWork(f);
  f.controller.dispose();
});
test('user-scope unknown conflicts across Workspaces; unknown workspace change permits only independent workspace', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'user');
  await f.controller.select('foreign');
  await f.controller.openMcp();
  await f.controller.chooseMcp('user', true, 'workspace');
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.error).toBe('mcp_original_outcome_required');
  f.controller.dispose();
  const g = fixture();
  await g.controller.select('a');
  await g.controller.openMcp();
  await g.controller.chooseMcp('refresh', true, 'workspace');
  await g.controller.select('foreign');
  await g.controller.openMcp();
  await g.controller.chooseMcp('user', true, 'user');
  expect(g.sent).toHaveLength(1);
  expect(g.controller.state.error).toBe('mcp_original_outcome_required');
  await g.controller.chooseMcp('user', true, 'workspace');
  expect(g.sent).toHaveLength(2);
  noWork(f);
  noWork(g);
  g.controller.dispose();
});
test('128 unresolved original workspace intents retain every command; capacity refuses 129 without eviction or new ID', async () => {
  const f = fixture();
  for (let index = 0; index < 128; index++) {
    await f.controller.select(`isolated-${index}`);
    await f.controller.openMcp();
    await f.controller.chooseMcp('refresh', true, 'workspace');
  }
  expect(f.sent).toHaveLength(128);
  expect(new Set(f.sent.map((intent) => intent.request.commandId)).size).toBe(128);
  await f.controller.select('isolated-128');
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'workspace');
  expect(f.controller.state.error).toBe('mcp_intent_limit');
  expect(f.counts().identities).toBe(128);
  expect(f.sent).toHaveLength(128);
  for (let index = 0; index < 128; index++) {
    await f.controller.select(`isolated-${index}`);
    await f.controller.openMcp();
    expect(f.controller.state.mcpOutcome!.intent).toBe(f.sent[index]!);
    expect(f.controller.state.mcpOutcome!.phase).toBe('outcome_unknown');
    await f.controller.lookupMcp();
  }
  expect(f.lookups).toEqual(f.sent);
  expect(f.sent).toHaveLength(128);
  noWork(f);
  f.controller.dispose();
});

test('new Ink observation abandons an old scope review and Enter cannot submit its stale proof', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm server change: refresh');
    await f.controller.openMcp();
    await tick();
    expect(ui.lastFrame()).not.toContain('Confirm server change:');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Server: refresh');
    expect(f.sent).toHaveLength(0);
    expect(f.counts().reads).toBe(2);
    noWork(f);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('Ink list keeps original unknown lookup reachable after Server removal and a failed empty-directory refresh', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    for (let enter = 0; enter < 3; enter++) {
      ui.stdin.write('\r');
      await tick();
    }
    expect(f.sent).toHaveLength(1);
    const original = f.sent[0]!;
    expect(f.controller.state.mcpOutcome!.phase).toBe('outcome_unknown');
    f.port.mcp!.read = async () => decodeTuiMcpSnapshot(query({ ...observed(), items: [] }));
    ui.stdin.write('\u001b[B'.repeat(3));
    await tick();
    expect(ui.lastFrame()).toContain('› Refresh servers');
    ui.stdin.write('\r');
    await tick();
    expect(f.controller.state.mcp!.read).toBe('ready');
    expect(f.controller.state.mcp!.facts!.items).toEqual([]);
    expect(ui.lastFrame()).toContain('No configured MCP servers');
    expect(ui.lastFrame()).toContain('› Check original change');
    expect(ui.lastFrame()).not.toContain('Server: refresh');
    ui.stdin.write('\r');
    await tick();
    expect(f.lookups).toEqual([original]);
    expect(f.lookups[0]).toBe(original);
    expect(f.sent).toHaveLength(1);
    f.port.mcp!.read = async () => {
      throw Error('owned_empty_directory_read_failed');
    };
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(f.controller.state.mcp!.read).toBe('failed');
    expect(f.controller.state.mcp!.facts!.items).toEqual([]);
    expect(ui.lastFrame()).toContain('Server list unknown; refresh to verify');
    ui.stdin.write('\u001b[A');
    await tick();
    expect(ui.lastFrame()).toContain('› Check original change');
    ui.stdin.write('\r');
    await tick();
    expect(f.lookups).toEqual([original, original]);
    expect(f.lookups[1]).toBe(original);
    expect(f.controller.state.mcpOutcome!.intent).toBe(original);
    expect(f.sent).toHaveLength(1);
    expect(f.counts().identities).toBe(1);
    noWork(f);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('cold saved original IDs remain selectable with failed directory; restore performs no lookup and conflict blocks fresh choice', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'user');
  const original = f.sent[0]!;
  const second = {
    ...structuredClone(original),
    request: { ...structuredClone(original.request), commandId: 'cold-second' },
  };
  const cold = fixture();
  cold.port.mcp!.list = async () => [
    { intent: original, phase: 'outcome_unknown' },
    { intent: second, phase: 'outcome_unknown' },
  ];
  await cold.controller.select('a');
  await cold.controller.openMcp();
  expect(cold.lookups).toHaveLength(0);
  expect(cold.controller.state.mcpSaved).toHaveLength(2);
  await cold.controller.chooseMcp('user', true, 'workspace');
  expect(cold.sent).toHaveLength(0);
  expect(cold.controller.state.error).toBe('mcp_original_outcome_required');
  const ui = render(<TuiSession controller={cold.controller} />);
  try {
    for (const window of ['empty', 'failed'] as const) {
      cold.port.mcp!.read = async () => {
        if (window === 'failed') throw Error('directory_gone');
        return { ...observed(), items: [] };
      };
      await cold.controller.openMcp();
      await tick();
      expect(cold.controller.state.mcp!.read).toBe(window === 'empty' ? 'ready' : 'failed');
      expect(cold.controller.state.mcp!.facts!.items).toEqual([]);
      expect(ui.lastFrame()).toContain('Original change: cold-second');
      expect(ui.lastFrame()).toContain('› Check original change');
      for (let step = 0; step < 3; step++) {
        ui.stdin.write('\u001b[B');
        await tick();
      }
      expect(ui.lastFrame()).toContain('› Original change: cold-second');
      const before = cold.lookups.length;
      ui.stdin.write('\r');
      await tick();
      expect(cold.controller.state.mcpOutcome!.intent).toEqual(second);
      expect(cold.lookups).toHaveLength(before);
      expect(cold.sent).toHaveLength(0);
      for (let step = 0; step < 3; step++) {
        ui.stdin.write('\u001b[A');
        await tick();
      }
      expect(ui.lastFrame()).toContain('› Check original change');
      ui.stdin.write('\r');
      await tick();
      expect(cold.lookups.at(-1)).toEqual(second);
      expect(cold.lookups).toHaveLength(before + 1);
      expect(cold.sent).toHaveLength(0);
      noWork(cold);
    }
    expect(cold.lookups).toEqual([second, second]);
  } finally {
    ui.unmount();
    cold.controller.dispose();
    f.controller.dispose();
  }
});
test('corrupt cold journal blocks fresh submit and delayed restoration cannot reopen a closed panel', async () => {
  const f = fixture();
  await f.controller.select('a');
  f.port.mcp!.list = async () => {
    throw Error('mcp_selection_journal_unavailable');
  };
  await f.controller.openMcp();
  await f.controller.chooseMcp('refresh', true, 'user');
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.mcpUnavailable).toBe('mcp_selection_journal_unavailable');
  const deferredRows = deferred<TuiMcpOutcome[]>();
  f.port.mcp!.list = () => deferredRows.promise;
  const pending = f.controller.openMcp();
  f.controller.closePanel();
  deferredRows.resolve([]);
  await pending;
  expect(f.controller.state.panel).toBeUndefined();
  noWork(f);
  f.controller.dispose();
});
