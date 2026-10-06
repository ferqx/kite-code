import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiMcpSourceMutationIntent,
  type TuiMcpSourceMutationOutcome,
  type TuiMcpSourceSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

const sha = 'a'.repeat(64),
  id = `mcp-${sha}`,
  tick = () => new Promise<void>((r) => setTimeout(r, 20));
const snapshot: TuiMcpSourceSnapshot = {
  storeId: 'store',
  sessionId: 'a',
  workspaceId: 'w',
  workspaceIdentity: 'physical',
  registryRevision: 'r',
  errors: [],
  readSet: {
    scopeDigest: sha,
    user: {
      identity: { kind: 'user', pathDigest: sha, rootIdentity: sha },
      etag: null,
      error: null,
    },
    workspace: {
      identity: { kind: 'workspace', pathDigest: 'b'.repeat(64), rootIdentity: 'b'.repeat(64) },
      etag: null,
      error: null,
    },
    approvalEtag: null,
    bindingEtag: null,
    variablesDigest: sha,
  },
  items: [
    {
      id,
      name: 'owned',
      source: { kind: 'workspace', pathDigest: 'b'.repeat(64), rootIdentity: 'b'.repeat(64) },
      rawEntryDigest: sha,
      transportDigest: null,
      transport: 'http',
      enabled: false,
      admitted: false,
      reason: 'mcp_source_pending',
      configDigest: null,
    },
  ],
};
const saved = (commandId: string): TuiMcpSourceMutationOutcome => ({
  intent: {
    sessionId: 'original',
    workspaceId: 'w',
    workspaceIdentity: 'old-physical',
    request: {
      expectedStoreId: 'store',
      commandId,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.add',
      definitionVersion: '1',
      input: {
        scope: 'user',
        name: 'old',
        entry: { type: 'http', url: 'https://example.invalid' },
        expectedReadSet: snapshot.readSet!,
      },
    },
  },
  phase: 'outcome_unknown',
});
function fixture(rows: TuiMcpSourceMutationOutcome[] = [], directoryFails = false) {
  const sent: TuiMcpSourceMutationIntent[] = [],
    lookups: TuiMcpSourceMutationIntent[] = [];
  let business = 0,
    minted = 0;
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `new-${++minted}`,
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
    submit: async () => {
      business++;
      throw Error('unexpected Run');
    },
    getCommand: async () => {
      business++;
      throw Error('unexpected command GET');
    },
    cancel: async () => {
      business++;
      throw Error('unexpected cancel');
    },
    answer: async () => {
      business++;
      throw Error('unexpected answer');
    },
    mcp: {
      read: async () => {
        throw Error('management unavailable');
      },
      submit: async () => {
        throw Error('selection forbidden');
      },
      lookup: async () => {
        throw Error('selection forbidden');
      },
      sourceMutation: {
        read: async () => {
          if (directoryFails) throw Error('removed');
          return snapshot;
        },
        list: async () => rows,
        preview: async () => ({
          target: {
            serverId: id,
            name: 'owned',
            source: snapshot.items[0]!.source,
            rawEntryDigest: sha,
            transport: 'http',
            enabled: false,
            reason: 'mcp_source_pending',
          },
          fallback: {
            serverId: `mcp-${'c'.repeat(64)}`,
            name: 'revealed-user',
            source: snapshot.readSet!.user.identity,
            rawEntryDigest: sha,
            transport: 'stdio',
            enabled: true,
            reason: null,
          },
        }),
        submit: async (intent) => {
          sent.push(intent);
          return { intent, phase: 'pending' };
        },
        lookup: async (intent) => {
          lookups.push(intent);
          return { intent, phase: 'outcome_unknown' };
        },
      },
    },
  };
  return {
    controller: new TuiController(port),
    port,
    mutationPort: port.mcp!.sourceMutation!,
    sent,
    lookups,
    counts: () => ({ business, minted }),
  };
}
async function press(ui: ReturnType<typeof render>, key: string) {
  ui.stdin.write(key);
  await tick();
}
async function open(f: ReturnType<typeof fixture>) {
  await f.controller.select('a');
  await f.controller.openMcp();
  await f.controller.openMcpSourceMutations();
}
test('actual Ink Add edits separate buffers, explicit Review and Confirm submit once without answering or Model task', async () => {
  const f = fixture();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    await press(ui, '\r');
    await tick();
    await press(ui, 'new_owned');
    await press(ui, '\r');
    await tick();
    await press(ui, '\r');
    await tick();
    await press(ui, 'https://example.invalid/mcp');
    await press(ui, '\r');
    await tick();
    await press(ui, '\r');
    await tick();
    expect(ui.lastFrame()).toContain('Review source entry change');
    expect(f.sent).toHaveLength(0);
    await press(ui, '\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm source entry change');
    expect(f.sent).toHaveLength(0);
    await press(ui, '\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.request.actionId).toBe('mcp.source.add');
    expect(f.sent[0]!.request.input).toMatchObject({
      scope: 'workspace',
      name: 'new_owned',
      entry: { type: 'http', url: 'https://example.invalid/mcp' },
    });
    expect(f.counts()).toEqual({ business: 0, minted: 1 });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
test('actual Ink Remove works without admitted selection, shows revealed user and keeps confirmation independent', async () => {
  const f = fixture();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    await press(ui, '\x1b[B');
    await press(ui, '\r');
    await tick();
    expect(ui.lastFrame()).toContain('Review source entry change');
    await press(ui, '\x1b[F');
    await tick();
    expect(ui.lastFrame()).toContain('revealed-user');
    expect(f.sent).toHaveLength(0);
    await press(ui, '\r');
    await tick();
    expect(f.sent).toHaveLength(0);
    await press(ui, '\r');
    await tick();
    expect(f.sent[0]!.request.input).toMatchObject({
      scope: 'workspace',
      serverId: id,
      expectedRawEntryDigest: sha,
    });
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});
test('failed directory keeps second original keyboard reachable; selecting zero GET, explicit Check original session only', async () => {
  const f = fixture([saved('first'), saved('second')], true);
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    await press(ui, '\x1b[B');
    await press(ui, '\x1b[B');
    await press(ui, '\r');
    await tick();
    expect(ui.lastFrame()).toContain('second');
    expect(f.lookups).toHaveLength(0);
    await press(ui, '\x1b[B');
    await press(ui, '\r');
    await tick();
    expect(f.lookups).toHaveLength(1);
    expect(f.lookups[0]!.request.commandId).toBe('second');
    expect(f.lookups[0]!.sessionId).toBe('original');
    expect(f.sent).toHaveLength(0);
    expect(f.counts().business).toBe(0);
    await press(ui, '\x03');
    await tick();
    expect(f.controller.state.mcpMutationOpen).toBe(false);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('selecting and checking an original source change keeps the current directory reader alive', async () => {
  const f = fixture([saved('first')]);
  let resolve!: (value: TuiMcpSourceSnapshot) => void;
  let signal: AbortSignal | undefined;
  f.mutationPort.read = (_sessionId, readerSignal) => {
    signal = readerSignal;
    return new Promise((r) => {
      resolve = r;
    });
  };
  await f.controller.select('a');
  await f.controller.openMcp();
  const opening = f.controller.openMcpSourceMutations();
  await tick();
  f.controller.selectMcpSourceMutation('first');
  expect(signal?.aborted).toBe(false);
  await f.controller.lookupMcpSourceMutation();
  expect(signal?.aborted).toBe(false);
  expect(f.controller.state.mcpMutationFactsReading).toBe(true);
  expect(f.controller.state.mcpMutationReading).toBe(false);
  resolve(snapshot);
  await opening;
  expect(f.controller.state.mcpMutationFacts).toEqual(snapshot);
  expect(f.controller.state.mcpMutationFactsReading).toBe(false);
  expect(f.controller.state.mcpMutationOutcome?.intent.request.commandId).toBe('first');
  expect(f.lookups).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
  expect(f.counts()).toEqual({ business: 0, minted: 0 });
  f.controller.dispose();
});

test('same-session history refresh preserves both source readers and their actual pending states', async () => {
  const f = fixture([saved('first')]);
  let resolveFacts!: (value: TuiMcpSourceSnapshot) => void;
  let resolveOriginal!: (value: TuiMcpSourceMutationOutcome) => void;
  let factsSignal: AbortSignal | undefined;
  let originalSignal: AbortSignal | undefined;
  f.mutationPort.read = (_sessionId, signal) => {
    factsSignal = signal;
    return new Promise((r) => {
      resolveFacts = r;
    });
  };
  f.mutationPort.lookup = (_intent, signal) => {
    originalSignal = signal;
    return new Promise((r) => {
      resolveOriginal = r;
    });
  };
  await f.controller.select('a');
  await f.controller.openMcp();
  const opening = f.controller.openMcpSourceMutations();
  await tick();
  f.controller.selectMcpSourceMutation('first');
  const lookup = f.controller.lookupMcpSourceMutation();
  await f.controller.select('a');
  expect(factsSignal?.aborted).toBe(false);
  expect(originalSignal?.aborted).toBe(false);
  expect(f.controller.state.mcpMutationFactsReading).toBe(true);
  expect(f.controller.state.mcpMutationReading).toBe(true);
  resolveOriginal({ ...saved('first'), phase: 'saved' });
  await lookup;
  expect(f.controller.state.mcpMutationFactsReading).toBe(true);
  expect(f.controller.state.mcpMutationReading).toBe(false);
  resolveFacts(snapshot);
  await opening;
  expect(f.controller.state.mcpMutationFacts).toEqual(snapshot);
  expect(f.controller.state.mcpMutationOutcome?.phase).toBe('saved');
  expect(f.controller.state.mcpMutationFactsReading).toBe(false);
  expect(f.counts()).toEqual({ business: 0, minted: 0 });
  f.controller.dispose();
});

for (const change of ['close', 'session', 'workspace'] as const) {
  test(`source directory reader aborts on ${change}; late facts cannot restore the old scope`, async () => {
    const f = fixture([saved('first')]);
    let resolve!: (value: TuiMcpSourceSnapshot) => void;
    let signal: AbortSignal | undefined;
    f.mutationPort.read = (_sessionId, readerSignal) => {
      signal = readerSignal;
      return new Promise((r) => {
        resolve = r;
      });
    };
    await f.controller.select('a');
    await f.controller.openMcp();
    const opening = f.controller.openMcpSourceMutations();
    await tick();
    if (change === 'close') f.controller.closeMcpSourceMutations();
    else if (change === 'session') await f.controller.select('other-session');
    else {
      const readSession = f.port.readSession;
      f.port.readSession = async (id, options) => {
        const value = await readSession(id, options);
        return {
          ...value,
          view: {
            ...value.view,
            session: { ...value.view.session, workspaceId: 'other-workspace' },
          },
        };
      };
      await f.controller.select('a');
    }
    expect(signal?.aborted).toBe(true);
    resolve(snapshot);
    await opening;
    expect(f.controller.state.mcpMutationOpen).toBe(false);
    expect(f.controller.state.mcpMutationFacts).toBeUndefined();
    expect(f.controller.state.mcpMutationFactsReading).toBe(false);
    expect(f.counts()).toEqual({ business: 0, minted: 0 });
    f.controller.dispose();
  });
}

test('refreshing the source directory cancels its previous reader and ignores an older late snapshot', async () => {
  const f = fixture();
  const pending: { resolve: (value: TuiMcpSourceSnapshot) => void; signal: AbortSignal }[] = [];
  f.mutationPort.read = (_sessionId, signal) =>
    new Promise((resolve) => pending.push({ resolve, signal }));
  await f.controller.select('a');
  await f.controller.openMcp();
  const first = f.controller.openMcpSourceMutations();
  await tick();
  const second = f.controller.openMcpSourceMutations();
  await tick();
  expect(pending[0]!.signal.aborted).toBe(true);
  expect(pending[1]!.signal.aborted).toBe(false);
  const current = { ...snapshot, registryRevision: 'current' };
  pending[1]!.resolve(current);
  await second;
  pending[0]!.resolve(snapshot);
  await first;
  expect(f.controller.state.mcpMutationFacts).toEqual(current);
  expect(f.controller.state.mcpMutationFactsReading).toBe(false);
  expect(f.counts()).toEqual({ business: 0, minted: 0 });
  f.controller.dispose();
});

test('reader closes and scope switches abort owned lookup; late original result cannot overwrite second original', async () => {
  const f = fixture([saved('first'), saved('second')], true);
  await open(f);
  let resolve!: (value: TuiMcpSourceMutationOutcome) => void;
  let signal: AbortSignal | undefined;
  f.mutationPort.lookup = (_intent, readerSignal) => {
    signal = readerSignal;
    return new Promise((r) => {
      resolve = r;
    });
  };
  f.controller.selectMcpSourceMutation('first');
  const reading = f.controller.lookupMcpSourceMutation();
  await tick();
  f.controller.selectMcpSourceMutation('second');
  expect(signal?.aborted).toBe(true);
  resolve({ ...saved('first'), phase: 'saved' });
  await reading;
  expect(f.controller.state.mcpMutationOutcome?.intent.request.commandId).toBe('second');
  expect(f.controller.state.mcpMutationOutcome?.phase).toBe('outcome_unknown');
  const next = f.controller.lookupMcpSourceMutation();
  await tick();
  await f.controller.select('other-session');
  expect(signal?.aborted).toBe(true);
  resolve({ ...saved('second'), phase: 'saved' });
  await next;
  expect(f.controller.state.mcpMutationOpen).toBe(false);
  expect(f.controller.state.snapshot?.view.session.id).toBe('other-session');
  expect(f.counts().business).toBe(0);
});
