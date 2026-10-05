import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiMcpConnectionIntent,
  type TuiMcpConnectionOutcome,
  type TuiMcpSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const snapshot = (sessionId = 'a', workspaceId = 'w'): TuiMcpSnapshot => ({
  storeId: 'store',
  sessionId,
  workspaceId,
  workspaceIdentity: `identity-${workspaceId}`,
  workspacePath: `/owned/${workspaceId}`,
  registryRevision: 'r',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: 'b'.repeat(64),
    explicitDigest: 'c'.repeat(64),
    registryDigest: 'd'.repeat(64),
    registryRevision: 'r',
    scopeDigest: 'e'.repeat(64),
  },
  items: [
    {
      id: 'server',
      configDigest: 'f'.repeat(64),
      transport: 'http',
      source: { kind: 'user', id: 'owned', revision: '1' },
      selected: true,
      available: true,
      admitted: true,
      reason: null,
    },
  ],
});
const original = (id: string, serverId = 'server'): TuiMcpConnectionIntent => ({
  sessionId: 'a',
  workspaceId: 'old-w',
  workspaceIdentity: 'old-identity',
  request: {
    expectedStoreId: 'store',
    commandId: id,
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId, key: `key-${id}` },
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
function fixture(saved: TuiMcpConnectionOutcome[] = []) {
  let minted = 0,
    business = 0,
    workspaceId = 'w';
  const sent: { intent: TuiMcpConnectionIntent; observed: TuiMcpSnapshot }[] = [],
    lookups: TuiMcpConnectionIntent[] = [],
    signals: AbortSignal[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `connect-${++minted}`,
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
      interactions: [],
    }),
    getCommand: async () => {
      business++;
      throw Error('unexpected business GET');
    },
    submit: async () => {
      business++;
      throw Error('unexpected Run');
    },
    answer: async () => {
      business++;
      throw Error('unexpected answer');
    },
    cancel: async () => {
      business++;
      throw Error('unexpected cancel');
    },
    mcp: {
      read: async (id) => snapshot(id, workspaceId),
      submit: async () => {
        business++;
        throw Error('unexpected select');
      },
      lookup: async () => {
        business++;
        throw Error('unexpected selection lookup');
      },
      connection: {
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
    counts: () => ({ minted, business }),
    workspace: (id: string) => {
      workspaceId = id;
    },
  };
}
async function open(f: ReturnType<typeof fixture>) {
  await f.controller.select('a');
  await f.controller.openMcp();
}
test('Ink Request connection has a distinct confirmation, mints once, passes original observation, and accepted remains pending', async () => {
  const f = fixture();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\u001b[B'.repeat(5));
    await tick();
    expect(ui.lastFrame()).toContain('› Request connection');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm connection request:');
    expect(f.sent).toHaveLength(0);
    expect(f.counts().minted).toBe(0);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.observed).toBe(f.controller.state.mcp!.facts!);
    expect(f.sent[0]!.intent.request.input.key).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
    expect(ui.lastFrame()).toContain('Waiting for original connection');
    expect(ui.lastFrame()).not.toContain('Original catalogue ready');
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.counts().minted).toBe(1);
    ui.stdin.write('\u0003');
    await tick();
    expect(f.controller.state.panel).toBeUndefined();
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
for (const failed of [false, true])
  test(`Ink original second connection remains reachable in ${failed ? 'failed' : 'empty'} directory; selection zero GET, explicit Check only original GET`, async () => {
    const f = fixture(
      ['first', 'second'].map((id) => ({ intent: original(id), phase: 'outcome_unknown' })),
    );
    f.port.mcp!.read = async (id) => {
      if (failed) throw Error('directory unavailable');
      return { ...snapshot(id), items: [] };
    };
    await open(f);
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      ui.stdin.write('\u001b[B'.repeat(4));
      await tick();
      expect(ui.lastFrame()).toContain('› Original connection: second');
      ui.stdin.write('\r');
      await tick();
      expect(f.lookups).toHaveLength(0);
      expect(f.controller.state.mcpConnection?.intent.request.commandId).toBe('second');
      ui.stdin.write('\u001b[A'.repeat(2));
      await tick();
      expect(ui.lastFrame()).toContain('› Check original connection');
      ui.stdin.write('\r');
      await tick();
      expect(f.lookups.map((x) => x.request.commandId)).toEqual(['second']);
      expect(f.sent).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  });
test('stale observation and unselected/unadmitted/unavailable Servers never mint or submit', async () => {
  const f = fixture();
  await open(f);
  const old = f.controller.state.mcp!.facts!;
  await f.controller.openMcp();
  await f.controller.requestMcpConnection('server', old);
  expect(f.sent).toHaveLength(0);
  for (const field of ['selected', 'admitted', 'available'] as const) {
    f.port.mcp!.read = async (id) => {
      const row = snapshot(id);
      row.items = [{ ...row.items[0]!, [field]: false }];
      return row;
    };
    await f.controller.openMcp();
    await f.controller.requestMcpConnection('server');
  }
  expect(f.counts()).toEqual({ minted: 0, business: 0 });
  f.controller.dispose();
});
test('unconfirmed conflict stays Store/Session/Server even after Workspace changes; another Session remains independent', async () => {
  const f = fixture();
  await open(f);
  await f.controller.requestMcpConnection('server');
  f.workspace('new-w');
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.requestMcpConnection('server');
  expect(f.sent).toHaveLength(1);
  expect(f.controller.state.error).toBe('mcp_original_connection_required');
  await f.controller.select('b');
  await f.controller.openMcp();
  await f.controller.requestMcpConnection('server');
  expect(f.sent).toHaveLength(2);
  expect(f.sent[1]!.intent.sessionId).toBe('b');
  expect(f.counts().business).toBe(0);
  f.controller.dispose();
});
test('late submit preserves original saved outcome but cannot replace a later selected original', async () => {
  const f = fixture([{ intent: original('second', 'other-server'), phase: 'outcome_unknown' }]);
  const d = deferred<TuiMcpConnectionOutcome>();
  f.port.mcp!.connection!.submit = async (intent, observed) => {
    f.sent.push({ intent, observed });
    return d.promise;
  };
  await open(f);
  const work = f.controller.requestMcpConnection('server');
  await tick();
  f.controller.selectMcpConnection('second');
  d.resolve({ intent: f.sent[0]!.intent, phase: 'pending' });
  await work;
  expect(f.controller.state.mcpConnection?.intent.request.commandId).toBe('second');
  expect(
    f.controller.state.mcpConnections?.find(
      (x) => x.intent.request.commandId === f.sent[0]!.intent.request.commandId,
    )?.phase,
  ).toBe('pending');
  expect(f.counts().business).toBe(0);
  f.controller.dispose();
});
test('lookup close/switch aborts only owned reader and late result cannot populate another scope', async () => {
  const f = fixture([{ intent: original('first'), phase: 'outcome_unknown' }]);
  const d = deferred<TuiMcpConnectionOutcome>();
  f.port.mcp!.connection!.lookup = async (intent, signal) => {
    f.lookups.push(intent);
    f.signals.push(signal);
    return d.promise;
  };
  await open(f);
  const work = f.controller.lookupMcpConnection();
  await tick();
  f.controller.closePanel();
  await f.controller.select('b');
  d.resolve({ intent: original('first'), phase: 'ready' });
  await work;
  expect(f.signals[0]!.aborted).toBe(true);
  expect(f.controller.state.mcpConnection).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  expect(f.counts().business).toBe(0);
  f.controller.dispose();
});
test('ready original fact displays warm reuse and cold nonlive separately; no renewed submit', async () => {
  const f = fixture([{ intent: original('saved'), phase: 'outcome_unknown' }]);
  f.port.mcp!.connection!.lookup = async (intent, signal) => {
    f.lookups.push(intent);
    f.signals.push(signal);
    return {
      intent,
      phase: 'ready',
      fact: {
        storeId: 'store',
        sessionId: 'a',
        execution: {
          id: 'action',
          originStoreId: 'store',
          sessionId: 'a',
          originCommandId: 'saved',
          parentExecutionId: null,
          kind: 'job',
          definitionId: 'builtin.mcp/mcp.connect',
          definitionVersion: '1',
          inputDigest: 'a'.repeat(64),
          status: 'succeeded',
        },
        phase: 'ready',
        operationRef: {
          commandId: 'job-command',
          sessionId: 'a',
          originStoreId: 'store',
          extensionId: 'builtin.mcp',
          key: 'connection/server/key-saved',
          executionId: 'job',
        },
        connection: {
          id: 'job',
          originStoreId: 'store',
          sessionId: 'a',
          originCommandId: 'job-command',
          parentExecutionId: 'action',
          kind: 'job',
          definitionId: 'builtin.mcp/mcp.source.connection',
          definitionVersion: '1',
          status: 'running',
        },
        ready: { serverId: 'server', configDigest: 'b'.repeat(64), generation: 1, toolCount: 40 },
        live: f.lookups.length === 1,
        currentGeneration: f.lookups.length === 1 ? 1 : null,
        created: false,
        reason: null,
      },
    };
  };
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await f.controller.lookupMcpConnection();
    await tick();
    expect(ui.lastFrame()).toContain('Original catalogue ready');
    expect(ui.lastFrame()).toContain('Reused original connection');
    expect(ui.lastFrame()).toContain('Live connection observed');
    await f.controller.lookupMcpConnection();
    await tick();
    expect(ui.lastFrame()).toContain('Original catalogue ready');
    expect(ui.lastFrame()).toContain('Live connection not confirmed');
    expect(ui.lastFrame()).not.toContain('Created by original request');
    expect(f.sent).toHaveLength(0);
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
test('128 unknown originals are retained; capacity and corrupt restoration mint no new identity', async () => {
  const rows = Array.from(
    { length: 128 },
    (_, index): TuiMcpConnectionOutcome => ({
      intent: original(`saved-${index}`, `other-${index}`),
      phase: 'outcome_unknown',
    }),
  );
  const f = fixture(rows);
  await open(f);
  await f.controller.requestMcpConnection('server');
  expect(f.controller.state.mcpConnections).toHaveLength(128);
  expect(f.counts().minted).toBe(0);
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.error).toBe('mcp_connection_intent_limit');
  f.controller.dispose();
  const bad = fixture([rows[0]!, rows[0]!]);
  await open(bad);
  await bad.controller.requestMcpConnection('server');
  expect(bad.controller.state.mcpConnectionUnavailable).toBe('mcp_connection_restore_conflict');
  expect(bad.counts().minted).toBe(0);
  expect(bad.sent).toHaveLength(0);
  bad.controller.dispose();
});
