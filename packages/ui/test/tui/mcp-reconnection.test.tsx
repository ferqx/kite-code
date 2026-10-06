import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiMcpConnectionIntent,
  type TuiMcpConnectionOutcome,
  type TuiMcpReconnectionCarrier,
  type TuiMcpReconnectionIntent,
  type TuiMcpReconnectionObservation,
  type TuiMcpReconnectionOutcome,
  type TuiMcpSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function deferred<T>() {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (v: T) => resolve(v),
  };
}
const snapshot = (sessionId = 's', workspaceId = 'w'): TuiMcpSnapshot => ({
  storeId: 'store',
  sessionId,
  workspaceId,
  workspaceIdentity: 'identity-w',
  workspacePath: '/owned/w',
  registryRevision: 'r',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    registryDigest: 'c'.repeat(64),
    registryRevision: 'r',
    scopeDigest: 'd'.repeat(64),
  },
  items: [
    {
      id: 'server',
      configDigest: 'e'.repeat(64),
      transport: 'http',
      source: { kind: 'programmatic', id: 'owned', revision: '1' },
      admitted: true,
      selected: true,
      available: true,
      reason: null,
    },
  ],
});
const connectionIntent = (): TuiMcpConnectionIntent => ({
  sessionId: 's',
  workspaceId: 'w',
  workspaceIdentity: 'identity-w',
  request: {
    expectedStoreId: 'store',
    commandId: 'warm_B',
    kind: 'extension.invoke',
    extensionId: 'builtin.mcp',
    actionId: 'mcp.connect',
    definitionVersion: '1',
    input: { serverId: 'server', key: 'warm_key_B' },
  },
});
function connectionOutcome(intent = connectionIntent()): TuiMcpConnectionOutcome {
  return {
    intent,
    phase: 'ready',
    fact: {
      storeId: 'store',
      sessionId: 's',
      phase: 'ready',
      execution: {
        id: 'carrier_B',
        originStoreId: 'store',
        sessionId: 's',
        originCommandId: intent.request.commandId,
        parentExecutionId: null,
        kind: 'job',
        definitionId: 'builtin.mcp/mcp.connect',
        definitionVersion: '1',
        status: 'succeeded',
        inputDigest: 'a'.repeat(64),
      },
      operationRef: {
        commandId: 'original_A',
        sessionId: 's',
        originStoreId: 'store',
        extensionId: 'builtin.mcp',
        key: 'connection/server/original_key_A',
        executionId: 'connection_A',
      },
      connection: {
        id: 'connection_A',
        originStoreId: 'store',
        sessionId: 's',
        originCommandId: 'original_A',
        parentExecutionId: 'carrier_A',
        kind: 'job',
        definitionId: 'mcp.connection.server',
        definitionVersion: 'e'.repeat(64),
        status: 'running',
      },
      ready: { serverId: 'server', configDigest: 'e'.repeat(64), generation: 1, toolCount: 3 },
      live: true,
      currentGeneration: 1,
      created: false,
      reason: null,
    },
  };
}
function original(id = 'original_R'): TuiMcpReconnectionIntent {
  const old = connectionIntent();
  return {
    sessionId: 's',
    workspaceId: 'w',
    workspaceIdentity: 'identity-w',
    targetRequest: old.request,
    request: {
      expectedStoreId: 'store',
      commandId: id,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp',
      actionId: 'mcp.reconnect',
      definitionVersion: '1',
      input: {
        serverId: 'server',
        key: `key_${id}`,
        target: {
          carrierExecutionId: 'carrier_B',
          carrierKey: old.request.input.key,
          operationRef: {
            commandId: 'original_A',
            sessionId: 's',
            originStoreId: 'store',
            extensionId: 'builtin.mcp',
            key: 'connection/server/original_key_A',
            executionId: 'connection_A',
          },
          connectionExecutionId: 'connection_A',
          configDigest: 'e'.repeat(64),
          currentGeneration: 1,
        },
        replacement: { kind: 'static', expectedConfigDigest: 'e'.repeat(64) },
      },
    },
  };
}
function ready(intent: TuiMcpReconnectionIntent): TuiMcpReconnectionOutcome {
  const id = intent.request.commandId,
    generation = intent.request.input.target.currentGeneration + 1;
  return {
    intent,
    phase: 'ready',
    fact: {
      storeId: intent.request.expectedStoreId,
      sessionId: intent.sessionId,
      phase: 'ready',
      execution: {
        id: `carrier_${id}`,
        originStoreId: intent.request.expectedStoreId,
        sessionId: intent.sessionId,
        originCommandId: id,
        parentExecutionId: null,
        kind: 'job',
        definitionId: 'builtin.mcp/mcp.reconnect',
        definitionVersion: '1',
        status: 'succeeded',
        inputDigest: 'b'.repeat(64),
      },
      target: intent.request.input.target,
      oldStop: {
        confirmed: true,
        execution: {
          id: intent.request.input.target.connectionExecutionId,
          originStoreId: 'store',
          sessionId: 's',
          originCommandId: intent.request.input.target.operationRef.commandId,
          parentExecutionId: 'carrier_A',
          kind: 'job',
          definitionId: 'mcp.connection.server',
          definitionVersion: 'e'.repeat(64),
          status: 'cancelled',
          resultRevision: '1',
        },
      },
      newOperationRef: {
        commandId: `new_job_${id}`,
        sessionId: intent.sessionId,
        originStoreId: intent.request.expectedStoreId,
        extensionId: 'builtin.mcp',
        key: `connection/server/${intent.request.input.key}`,
        executionId: `new_connection_${id}`,
      },
      newConnection: {
        id: `new_connection_${id}`,
        originStoreId: intent.request.expectedStoreId,
        sessionId: intent.sessionId,
        originCommandId: `new_job_${id}`,
        parentExecutionId: `carrier_${id}`,
        kind: 'job',
        definitionId: 'mcp.connection.server',
        definitionVersion: 'e'.repeat(64),
        status: 'running',
      },
      ready: { serverId: 'server', configDigest: 'e'.repeat(64), generation, toolCount: 3 },
      live: true,
      currentGeneration: generation,
      reason: null,
    },
  };
}
function fixture(saved: TuiMcpReconnectionOutcome[] = []) {
  let minted = 0,
    business = 0;
  const observed: TuiMcpReconnectionCarrier[] = [],
    sent: { intent: TuiMcpReconnectionIntent; observed: TuiMcpReconnectionObservation }[] = [],
    lookups: TuiMcpReconnectionIntent[] = [],
    signals: AbortSignal[] = [];
  const known = new Map<string, TuiMcpReconnectionOutcome>();
  let currentConnection = connectionOutcome();
  const observe = (carrier: TuiMcpReconnectionCarrier): TuiMcpReconnectionObservation => {
    const outcome =
      carrier.request.actionId === 'mcp.connect'
        ? currentConnection
        : known.get(carrier.request.commandId);
    if (!outcome) throw Error('fixture_original_outcome_missing');
    const fact = outcome.fact!;
    const operationRef = 'newOperationRef' in fact ? fact.newOperationRef! : fact.operationRef!;
    const connection = 'newConnection' in fact ? fact.newConnection! : fact.connection!;
    return {
      carrier,
      target: {
        carrierExecutionId: fact.execution.id,
        carrierKey: carrier.request.input.key,
        operationRef: {
          commandId: operationRef.commandId,
          sessionId: operationRef.sessionId,
          originStoreId: operationRef.originStoreId,
          extensionId: 'builtin.mcp',
          key: operationRef.key,
          executionId: connection.id,
        },
        connectionExecutionId: connection.id,
        configDigest: fact.ready!.configDigest,
        currentGeneration: fact.currentGeneration!,
      },
      replacement: { kind: 'static', expectedConfigDigest: 'e'.repeat(64) },
      management: snapshot(),
      source: null,
    };
  };
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `R_${++minted}`,
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        session: { id, workspaceId: 'w' },
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
      read: async (id) => snapshot(id),
      submit: async () => {
        business++;
        throw Error('unexpected configuration write');
      },
      lookup: async () => {
        business++;
        throw Error('unexpected selection lookup');
      },
      connection: {
        list: async () => [{ intent: connectionIntent(), phase: 'outcome_unknown' }],
        submit: async (intent) => {
          business++;
          return { intent, phase: 'pending' };
        },
        lookup: async () => currentConnection,
      },
      reconnection: {
        list: async () => saved,
        observe: async (carrier, signal) => {
          observed.push(carrier);
          signals.push(signal);
          return observe(carrier);
        },
        submit: async (intent, observation) => {
          sent.push({ intent, observed: observation });
          const result = ready(intent);
          known.set(intent.request.commandId, result);
          return result;
        },
        lookup: async (intent, signal) => {
          lookups.push(intent);
          signals.push(signal);
          const result = ready(intent);
          known.set(intent.request.commandId, result);
          return result;
        },
      },
    },
  };
  return {
    port,
    controller: new TuiController(port),
    observed,
    sent,
    lookups,
    signals,
    observe,
    counts: () => ({ minted, business }),
    connection: (value: TuiMcpConnectionOutcome) => {
      currentConnection = value;
    },
  };
}
async function open(f: ReturnType<typeof fixture>) {
  await f.controller.select('s');
  await f.controller.openMcp();
  f.controller.selectMcpConnection('warm_B');
  await f.controller.lookupMcpConnection();
}
async function choose(ui: ReturnType<typeof render>, label: string) {
  for (let i = 0; i < 20; i++) {
    if (ui.lastFrame()?.includes(`› ${label}`)) {
      ui.stdin.write('\r');
      await tick();
      return;
    }
    ui.stdin.write('\u001b[B');
    await tick();
  }
  throw Error(`owned_choice_unavailable:${label}`);
}

for (const change of [
  'offline-ready',
  'explicit-selection',
  'snapshot-failure-recovery',
  'workspace-roundtrip',
  'healthy-background',
] as const)
  test(`in-flight reconnection Review through ${change} does not restore invalid confirmation`, async () => {
    const f = fixture();
    await open(f);
    const started = deferred<TuiMcpReconnectionObservation>(),
      gate = deferred<TuiMcpReconnectionObservation>();
    const original = f.port.mcp!.reconnection!.observe;
    f.port.mcp!.reconnection!.observe = async (carrier, signal) => {
      const observation = await original(carrier, signal);
      started.resolve(observation);
      return gate.promise;
    };
    try {
      const pending = f.controller.reviewMcpReconnection('connection');
      const observation = await started.promise;
      if (change === 'offline-ready') {
        f.controller.observationUnavailable('owned-disconnect');
        f.controller.observationReady('store');
      } else if (change === 'explicit-selection') await f.controller.select('s');
      else if (change === 'snapshot-failure-recovery') {
        const read = f.port.readSession;
        f.port.readSession = async () => {
          throw Error('owned-history-failed');
        };
        await f.controller.select('s', { preserveReconnectionReview: true });
        f.port.readSession = read;
        await f.controller.select('s', { preserveReconnectionReview: true });
      } else if (change === 'workspace-roundtrip') {
        const read = f.port.readSession;
        f.port.readSession = async (id, signal) => {
          const value = await read(id, signal);
          return {
            ...value,
            view: {
              ...value.view,
              session: { ...value.view.session, workspaceId: 'other-workspace' },
            },
          };
        };
        await f.controller.select('s', { preserveReconnectionReview: true });
        f.port.readSession = read;
        await f.controller.select('s', { preserveReconnectionReview: true });
      } else await f.controller.select('s', { preserveReconnectionReview: true });
      gate.resolve(observation);
      await pending;
      const late = f.controller.state.mcpReconnectionObservation;
      await f.controller.confirmMcpReconnection(late);
      expect(f.sent).toHaveLength(change === 'healthy-background' ? 1 : 0);
      if (change === 'healthy-background') expect(late).toBeDefined();
      else expect(late).toBeUndefined();
      expect(f.counts()).toEqual({ minted: change === 'healthy-background' ? 1 : 0, business: 0 });
    } finally {
      f.controller.dispose();
    }
  });
test('same-Session background history refresh retains the exact independent reconnection review until Confirm', async () => {
  const f = fixture();
  await open(f);
  try {
    await f.controller.reviewMcpReconnection('connection');
    const observed = f.controller.state.mcpReconnectionObservation;
    expect(observed).toBeDefined();
    await f.controller.select('s', { preserveReconnectionReview: true });
    await f.controller.select('s', { preserveReconnectionReview: true });
    expect(f.controller.state.mcpReconnectionObservation).toBe(observed);
    expect(f.observed).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
    expect(f.counts()).toEqual({ minted: 0, business: 0 });
    await f.controller.confirmMcpReconnection(observed);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.observed).toBe(observed!);
    expect(f.sent[0]!.intent.request.input.target.carrierExecutionId).toBe('carrier_B');
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
  } finally {
    f.controller.dispose();
  }
});

for (const change of [
  'explicit-selection',
  'session',
  'workspace',
  'stale',
  'snapshot-failure',
] as const)
  test(`${change} still refuses the prior reconnection review after a background refresh`, async () => {
    const f = fixture();
    await open(f);
    try {
      await f.controller.reviewMcpReconnection('connection');
      const observed = f.controller.state.mcpReconnectionObservation;
      expect(observed).toBeDefined();
      if (change === 'explicit-selection') await f.controller.select('s');
      else if (change === 'session')
        await f.controller.select('other', { preserveReconnectionReview: true });
      else if (change === 'workspace') {
        const read = f.port.readSession;
        f.port.readSession = async (id, signal) => {
          const snapshot = await read(id, signal);
          return {
            ...snapshot,
            view: {
              ...snapshot.view,
              session: { ...snapshot.view.session, workspaceId: 'other-workspace' },
            },
          };
        };
        await f.controller.select('s', { preserveReconnectionReview: true });
      } else if (change === 'stale') {
        f.controller.observationUnavailable('owned-reset');
        f.controller.observationReady('store');
        await f.controller.select('s', { preserveReconnectionReview: true });
      } else {
        const read = f.port.readSession;
        f.port.readSession = async () => {
          throw Error('owned-snapshot-failure');
        };
        await f.controller.select('s', { preserveReconnectionReview: true });
        expect(f.controller.state.snapshotStale).toBe(true);
        await f.controller.confirmMcpReconnection(observed);
        expect(f.sent).toHaveLength(0);
        f.port.readSession = read;
        await f.controller.select('s', { preserveReconnectionReview: true });
        expect(f.controller.state.stale).toBe(false);
      }
      await f.controller.confirmMcpReconnection(observed);
      expect(f.sent).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      f.controller.dispose();
    }
  });

test('real Ink Review then independent Confirm submits once, warm B remains distinct from original Job A; second R keeps only previous request', async () => {
  const f = fixture();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    await choose(ui, 'Review forced reconnect');
    expect(f.observed).toHaveLength(1);
    expect(f.sent).toHaveLength(0);
    expect(f.counts().minted).toBe(0);
    expect(ui.lastFrame()).toContain('Confirm forced reconnect: server');
    expect(ui.lastFrame()).toContain('no automatic restore or tool permission');
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
    const first = f.sent[0]!;
    expect(first.intent.targetRequest).toEqual(connectionIntent().request);
    expect(first.intent.request.input.target.carrierKey).toBe('warm_key_B');
    expect(first.intent.request.input.target.operationRef.key).toBe(
      'connection/server/original_key_A',
    );
    expect(ui.lastFrame()).toContain('Original connection stop confirmed');
    expect(ui.lastFrame()).toContain('Replacement catalogue ready');
    expect(ui.lastFrame()).toContain('Live replacement observed');
    expect(f.controller.canReviewMcpReconnection('reconnection')).toBe(true);
    await choose(ui, 'Review forced reconnect');
    expect(f.observed).toHaveLength(2);
    expect(f.sent).toHaveLength(1);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.intent.targetRequest).toEqual(first.intent.request);
    expect(f.sent[1]!.intent.targetRequest).not.toHaveProperty('targetRequest');
    expect(f.sent[1]!.intent.request.commandId).not.toBe(first.intent.request.commandId);
    expect(f.sent[1]!.intent.request.input.key).not.toBe(first.intent.request.input.key);
    expect(f.sent[1]!.intent.request.input.target.currentGeneration).toBe(2);
    expect(f.counts()).toEqual({ minted: 2, business: 0 });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

for (const failed of [false, true])
  test(`cold ${failed ? 'failed' : 'empty'} directory keeps original R; selected ID zero GET and explicit Check reads only original`, async () => {
    const f = fixture(['first', 'second'].map((id) => ready(original(id))));
    f.port.mcp!.read = async (id) => {
      if (failed) throw Error('directory unavailable');
      return { ...snapshot(id), items: [] };
    };
    await f.controller.select('s');
    await f.controller.openMcp();
    await f.controller.openMcpReconnections();
    const ui = render(<TuiSession controller={f.controller} />);
    try {
      await tick();
      expect(f.lookups).toHaveLength(0);
      expect(f.observed).toHaveLength(0);
      await choose(ui, 'Original forced reconnect: second');
      expect(f.controller.state.mcpReconnection?.intent.request.commandId).toBe('second');
      expect(f.controller.state.mcpReconnection?.phase).toBe('outcome_unknown');
      expect(f.controller.canReviewMcpReconnection('reconnection')).toBe(false);
      expect(f.lookups).toHaveLength(0);
      expect(f.sent).toHaveLength(0);
      ui.stdin.write('\u001b[A'.repeat(10));
      await tick();
      await choose(ui, 'Check original forced reconnect');
      expect(f.lookups.map((r) => r.request.commandId)).toEqual(['second']);
      expect(f.sent).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      ui.unmount();
      f.controller.dispose();
    }
  });

test('closed restored intent rejects mixed/ref/Session/recursive payload; foreign original IDs remain visible but all HTTP refused', async () => {
  for (const corrupt of ['mixed', 'ref', 'session', 'recursive']) {
    const intent = original();
    if (corrupt === 'mixed') Object.assign(intent.request, { actionId: 'mcp.connect' });
    if (corrupt === 'ref') intent.request.input.target.operationRef.key = 'wrong';
    if (corrupt === 'session') intent.request.input.target.operationRef.sessionId = 'other';
    if (corrupt === 'recursive') Object.assign(intent.targetRequest, { targetRequest: {} });
    const f = fixture([{ intent, phase: 'outcome_unknown' }]);
    try {
      await f.controller.select('s');
      await f.controller.openMcp();
      await f.controller.openMcpReconnections();
      expect(f.controller.state.mcpReconnectionUnavailable).toBeDefined();
      expect(f.controller.state.mcpReconnections ?? []).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      f.controller.dispose();
    }
  }
  const foreign = original('foreign');
  foreign.request.expectedStoreId = 'old_store';
  foreign.targetRequest.expectedStoreId = 'old_store';
  foreign.request.input.target.operationRef.originStoreId = 'old_store';
  const f = fixture([{ intent: foreign, phase: 'outcome_unknown' }]);
  try {
    await f.controller.select('s');
    await f.controller.openMcp();
    await f.controller.openMcpReconnections();
    f.controller.selectMcpReconnection('foreign');
    expect(f.controller.state.mcpReconnection?.intent).toEqual(foreign);
    await f.controller.lookupMcpReconnection();
    expect(f.lookups).toHaveLength(0);
    await f.controller.reviewMcpReconnection('reconnection');
    expect(f.observed).toHaveLength(0);
    expect(f.counts()).toEqual({ minted: 0, business: 0 });
  } finally {
    f.controller.dispose();
  }
});

for (const bad of ['nonlive', 'generation', 'command', 'producer', 'ref'])
  test(`bad ${bad} original fact cannot enable Review or mint`, async () => {
    const f = fixture(),
      outcome = connectionOutcome();
    if (bad === 'nonlive') outcome.fact!.live = false;
    if (bad === 'generation') outcome.fact!.currentGeneration = 0;
    if (bad === 'command') outcome.fact!.execution.originCommandId = 'wrong';
    if (bad === 'producer') outcome.fact!.execution.definitionId = 'builtin.other/mcp.connect';
    if (bad === 'ref') outcome.fact!.operationRef!.executionId = 'wrong';
    f.connection(outcome);
    await open(f);
    try {
      expect(f.controller.canReviewMcpReconnection('connection')).toBe(false);
      await f.controller.reviewMcpReconnection('connection');
      expect(f.observed).toHaveLength(0);
      expect(f.sent).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      f.controller.dispose();
    }
  });

test('a refreshed live holder keeps original ready generation and reviews the separately observed current generation', async () => {
  const f = fixture(),
    outcome = connectionOutcome();
  outcome.fact!.currentGeneration = 4;
  f.connection(outcome);
  await open(f);
  try {
    expect(outcome.fact!.ready!.generation).toBe(1);
    expect(f.controller.canReviewMcpReconnection('connection')).toBe(true);
    await f.controller.reviewMcpReconnection('connection');
    expect(f.controller.state.mcpReconnectionObservation?.target.currentGeneration).toBe(4);
    expect(f.sent).toHaveLength(0);
    await f.controller.confirmMcpReconnection();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.intent.request.input.target.currentGeneration).toBe(4);
    expect(outcome.fact!.ready!.generation).toBe(1);
  } finally {
    f.controller.dispose();
  }
});

test('Esc/CtrlC close owns only observe/lookup AbortSignal; late submit stays original and cannot replace a newly selected R', async () => {
  const other = original('other');
  other.request.input.serverId = 'other_server';
  other.targetRequest.input.serverId = 'other_server';
  other.request.input.target.operationRef.key = 'connection/other_server/original_key_A';
  const f = fixture([{ intent: other, phase: 'failed' }]);
  await open(f);
  const observation = deferred<TuiMcpReconnectionObservation>();
  f.port.mcp!.reconnection!.observe = async (_carrier, signal) => {
    f.signals.push(signal);
    return observation.promise;
  };
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    const work = f.controller.reviewMcpReconnection('connection');
    await tick();
    ui.stdin.write('\u001b');
    await tick();
    expect(f.signals[0]!.aborted).toBe(true);
    observation.resolve(f.observe({ ...connectionIntent(), request: connectionIntent().request }));
    await work;
    expect(f.controller.state.mcpReconnectionObservation).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    f.port.mcp!.reconnection!.observe = async (carrier) => f.observe(carrier);
    await f.controller.reviewMcpReconnection('connection');
    const pending = deferred<TuiMcpReconnectionOutcome>();
    let sent!: TuiMcpReconnectionIntent;
    f.port.mcp!.reconnection!.submit = async (intent) => {
      sent = intent;
      return pending.promise;
    };
    const submission = f.controller.confirmMcpReconnection();
    await tick();
    f.controller.selectMcpReconnection('other');
    pending.resolve(ready(sent));
    await submission;
    expect(f.controller.state.mcpReconnection?.intent.request.commandId).toBe('other');
    expect(
      f.controller.state.mcpReconnections?.find(
        (r) => r.intent.request.commandId === sent.request.commandId,
      )?.phase,
    ).toBe('ready');
    const lookup = deferred<TuiMcpReconnectionOutcome>();
    f.port.mcp!.reconnection!.lookup = async (_intent, signal) => {
      f.signals.push(signal);
      return lookup.promise;
    };
    const reading = f.controller.lookupMcpReconnection();
    await tick();
    ui.stdin.write('\u0003');
    await tick();
    expect(f.signals.at(-1)!.aborted).toBe(true);
    lookup.resolve(ready(original('other')));
    await reading;
    expect(f.counts().business).toBe(0);
    expect(f.controller.state.mcpReconnectionOpen).toBe(false);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('unknown R blocks ordinary connection; unknown connect blocks forced Confirm; 128 unknown R never evicted', async () => {
  const f = fixture([{ intent: original(), phase: 'outcome_unknown' }]);
  await open(f);
  try {
    await f.controller.requestMcpConnection('server');
    expect(f.counts().business).toBe(0);
    expect(f.controller.state.error).toBe('mcp_original_connection_required');
    await f.controller.reviewMcpReconnection('connection');
    await f.controller.confirmMcpReconnection();
    expect(f.sent).toHaveLength(0);
    expect(f.counts().minted).toBe(0);
  } finally {
    f.controller.dispose();
  }
  const blocked = fixture();
  await open(blocked);
  try {
    await blocked.controller.reviewMcpReconnection('connection');
    expect(blocked.controller.state.mcpReconnectionObservation).toBeDefined();
    const pending = connectionIntent();
    pending.request.commandId = 'pending_connect';
    pending.request.input.key = 'pending_key';
    blocked.port.mcp!.connection!.list = async () => [
      { intent: connectionIntent(), phase: 'outcome_unknown' },
      { intent: pending, phase: 'pending' },
    ];
    await blocked.controller.confirmMcpReconnection();
    expect(blocked.sent).toHaveLength(0);
    expect(blocked.counts()).toEqual({ minted: 0, business: 0 });
    expect(blocked.controller.state.error).toBe('mcp_original_connection_required');
  } finally {
    blocked.controller.dispose();
  }
  const full = fixture(
    Array.from({ length: 128 }, (_, i) => ({
      intent: original(`saved_${i}`),
      phase: 'outcome_unknown' as const,
    })),
  );
  try {
    await full.controller.select('s');
    await full.controller.openMcp();
    await full.controller.openMcpReconnections();
    expect(full.controller.state.mcpReconnections).toHaveLength(128);
    expect(full.lookups).toHaveLength(0);
    expect(full.counts()).toEqual({ minted: 0, business: 0 });
  } finally {
    full.controller.dispose();
  }
});

for (const drift of ['target', 'management', 'source'])
  test(`new ${drift} observation drift cannot show Confirm or submit`, async () => {
    const f = fixture();
    await open(f);
    f.port.mcp!.reconnection!.observe = async (carrier) => {
      const observed = f.observe(carrier);
      if (drift === 'target') observed.target.currentGeneration++;
      if (drift === 'management') observed.management.workspaceId = 'other';
      if (drift === 'source')
        observed.replacement = {
          kind: 'source',
          expectedConfigDigest: 'a'.repeat(64),
          expectedReadSet: {
            scopeDigest: 'a'.repeat(64),
            user: {
              identity: { kind: 'user', pathDigest: 'b'.repeat(64), rootIdentity: 'c'.repeat(64) },
              etag: null,
              error: null,
            },
            workspace: null,
            approvalEtag: null,
            bindingEtag: null,
            variablesDigest: 'd'.repeat(64),
          },
        };
      return observed;
    };
    try {
      await f.controller.reviewMcpReconnection('connection');
      expect(f.controller.state.mcpReconnectionObservation).toBeUndefined();
      expect(f.controller.state.error).toBeDefined();
      await f.controller.confirmMcpReconnection();
      expect(f.sent).toHaveLength(0);
      expect(f.counts()).toEqual({ minted: 0, business: 0 });
    } finally {
      f.controller.dispose();
    }
  });

test('full Source observation remains frozen and passed unchanged into independent Confirm', async () => {
  const f = fixture();
  await open(f);
  f.port.mcp!.reconnection!.observe = async (carrier) => {
    const observed = f.observe(carrier);
    const expectedReadSet = {
      scopeDigest: 'a'.repeat(64),
      user: {
        identity: {
          kind: 'user' as const,
          pathDigest: 'b'.repeat(64),
          rootIdentity: 'c'.repeat(64),
        },
        etag: null,
        error: null,
      },
      workspace: {
        identity: {
          kind: 'workspace' as const,
          pathDigest: 'd'.repeat(64),
          rootIdentity: 'e'.repeat(64),
        },
        etag: 'f'.repeat(64),
        error: null,
      },
      approvalEtag: null,
      bindingEtag: null,
      variablesDigest: '1'.repeat(64),
    };
    observed.replacement = {
      kind: 'source',
      expectedConfigDigest: 'e'.repeat(64),
      expectedReadSet,
    };
    observed.source = {
      storeId: 'store',
      sessionId: 's',
      workspaceId: 'w',
      workspaceIdentity: 'identity-w',
      readSet: expectedReadSet,
      registryRevision: 'r',
      items: [
        {
          id: 'server',
          name: '原始 Server 名称',
          source: expectedReadSet.workspace.identity,
          rawEntryDigest: '2'.repeat(64),
          transportDigest: '3'.repeat(64),
          transport: 'http',
          enabled: true,
          admitted: true,
          reason: null,
          configDigest: 'e'.repeat(64),
        },
      ],
      errors: { user: null, workspace: null, approval: null, binding: null },
    };
    return observed;
  };
  try {
    await f.controller.reviewMcpReconnection('connection');
    const observed = f.controller.state.mcpReconnectionObservation!;
    expect(observed.source!.items[0]!.name).toBe('原始 Server 名称');
    expect(Object.isFrozen(observed.source)).toBe(true);
    await f.controller.confirmMcpReconnection();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.observed).toBe(observed);
    expect(f.sent[0]!.intent.request.input.replacement).toEqual(observed.replacement);
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
  } finally {
    f.controller.dispose();
  }
});
