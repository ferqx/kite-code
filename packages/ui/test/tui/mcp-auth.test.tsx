import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  callerKey,
  type TuiCallerIntent,
  TuiController,
  type TuiMcpAuthOutcome,
  type TuiMcpSourceSnapshot,
  type TuiPort,
  TuiSession,
} from '../../src/tui';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const serverId = `mcp-${'a'.repeat(64)}`;
const snapshot: TuiMcpSourceSnapshot = {
  storeId: 'store',
  sessionId: 'a',
  workspaceId: 'w',
  workspaceIdentity: 'physical',
  registryRevision: 'r',
  errors: [],
  readSet: {
    scopeDigest: '1'.repeat(64),
    variablesDigest: '2'.repeat(64),
    user: {
      identity: { kind: 'user', pathDigest: '3'.repeat(64), rootIdentity: '4'.repeat(64) },
      etag: null,
      error: null,
    },
    workspace: null,
    approvalEtag: null,
    bindingEtag: null,
  },
  items: [
    {
      id: serverId,
      name: 'owned',
      source: { kind: 'user', pathDigest: '3'.repeat(64), rootIdentity: '4'.repeat(64) },
      rawEntryDigest: '5'.repeat(64),
      transportDigest: '6'.repeat(64),
      transport: 'http',
      enabled: true,
      admitted: true,
      reason: null,
      configDigest: '7'.repeat(64),
    },
  ],
};
function intent(id = 'original', storeId = 'store', sessionId = 'a'): TuiCallerIntent {
  return {
    scope: { storeId, sessionId, workspaceId: 'w' },
    subjectId: 'subject',
    bodyDigest: '8'.repeat(64),
    requestDigest: '9'.repeat(64),
    target: { kind: 'session', id: sessionId },
    request: {
      expectedStoreId: storeId,
      commandId: id,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.auth.login',
      definitionVersion: '1',
      input: JSON.parse(JSON.stringify({ serverId, expectedReadSet: snapshot.readSet })),
    },
  };
}
function fixture(saved: TuiCallerIntent[] = []) {
  let minted = 0,
    business = 0,
    readFailed = false,
    authPrepared = 0;
  const sent: TuiCallerIntent[] = [],
    lookup: TuiCallerIntent[] = [],
    cancel: string[] = [];
  let deferred: ((signal: AbortSignal) => Promise<TuiMcpAuthOutcome>) | undefined;
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `auth-${++minted}`,
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
      throw Error('unexpected_model');
    },
    answer: async () => {
      business++;
      throw Error('unexpected_answer');
    },
    cancel: async () => {
      business++;
      throw Error('unexpected_cancel');
    },
    getCommand: async () => {
      throw Error('unused');
    },
    callers: {
      list: async () => saved.map((intent) => ({ intent, phase: 'unknown' })),
      prepare: async (_scope, request) => ({ ...intent(request.commandId), request }),
      submit: async (i) => {
        if (i.request.kind === 'execution.cancel') cancel.push(i.request.executionId);
        return { intent: i, phase: 'accepted' };
      },
      lookup: async (i) => ({ intent: i, phase: 'unknown' }),
      clear: async () => {
        throw Error('unexpected_clear');
      },
    },
    mcp: {
      read: async () => {
        throw Error('management_unavailable');
      },
      submit: async () => {
        throw Error('selection_unavailable');
      },
      lookup: async (i) => ({ intent: i, phase: 'outcome_unknown' }),
      source: {
        read: async () => {
          if (readFailed) throw Error('source_removed');
          return snapshot;
        },
        list: async () => [],
        submit: async (i) => ({ intent: i, phase: 'outcome_unknown' }),
        lookup: async (i) => ({ intent: i, phase: 'outcome_unknown' }),
      },
    },
    mcpAuth: {
      read: async () => ({
        serverId,
        workspaceId: 'w',
        loginAllowed: true,
        policy: 'oauth',
        status: 'available',
        credentialPresent: true,
      }),
      prepare: async (request) => {
        authPrepared++;
        return { ...intent(request.commandId), request };
      },
      submit: async (i) => {
        sent.push(i);
        return { intent: i, phase: 'applied' };
      },
      lookup: async (i, signal) => {
        lookup.push(i);
        if (deferred) return deferred(signal);
        return { intent: i, phase: 'outcome_unknown' };
      },
    },
  };
  const controller = new TuiController(port);
  return {
    port,
    controller,
    sent,
    lookup,
    cancel,
    counts: () => ({ minted, business }),
    authPrepared: () => authPrepared,
    sourceGone() {
      readFailed = true;
    },
    defer(value: typeof deferred) {
      deferred = value;
    },
  };
}
async function open(f: ReturnType<typeof fixture>) {
  await f.controller.select('a');
  await f.controller.openMcpSources();
}

test('Ink HTTP detail requires independent Review and Enter; applied Command remains pending, no Model/answer/connect', async () => {
  const f = fixture();
  await open(f);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('MCP authentication');
    expect(ui.lastFrame()).toContain('Review Login');
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm authentication: Login');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.request.kind).toBe('extension.invoke');
    expect(ui.lastFrame()).toContain('Authentication pending');
    expect(ui.lastFrame()).not.toContain('Credentials saved');
    expect(f.counts()).toEqual({ minted: 1, business: 0 });
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('cold source failure keeps keyboard originals including foreign; selection zero GET, explicit Check exactly original', async () => {
  const a = intent('first'),
    b = intent('second', 'foreign', 'old');
  const f = fixture([a, b]);
  await open(f);
  f.sourceGone();
  await f.controller.openMcpSources();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Original authentication requests');
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Original Store: foreign');
    expect(f.lookup).toHaveLength(0);
    ui.stdin.write('\u001b[A');
    await tick();
    ui.stdin.write('\u001b[A');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(f.lookup).toEqual([b]);
    expect(f.sent).toHaveLength(0);
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('reader close/scope switch cannot cancel business or render private thrown text; late old reply cannot overwrite new view', async () => {
  const a = intent();
  const f = fixture([a]);
  await open(f);
  await f.controller.openMcpAuth();
  f.controller.selectMcpAuthOriginal(callerKey(a));
  let release!: (x: TuiMcpAuthOutcome) => void;
  let readSignal!: AbortSignal;
  f.defer((signal) => {
    readSignal = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const reading = f.controller.lookupMcpAuth();
  f.controller.closeMcpAuth();
  expect(readSignal.aborted).toBe(true);
  await f.controller.select('b');
  release({ intent: a, phase: 'outcome_unknown' });
  await reading;
  expect(f.controller.state.mcpAuthOpen).toBe(false);
  expect(f.controller.state.mcpAuthOutcome).toBeUndefined();
  expect(f.cancel).toHaveLength(0);
  expect(f.counts().business).toBe(0);
  await f.controller.select('a');
  await f.controller.openMcpSources();
  await f.controller.openMcpAuth();
  f.controller.selectMcpAuthOriginal(callerKey(a));
  f.defer(async () => {
    throw Error('https://private.invalid/?access_token=private-secret');
  });
  await f.controller.lookupMcpAuth();
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    expect(ui.lastFrame()).toContain('Authentication unavailable');
    expect(ui.lastFrame()).not.toContain('private-secret');
    expect(ui.lastFrame()).not.toContain('https://');
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('clear/revoke and cancellation require separate confirmation; own original Execution cancel uses caller only', async () => {
  const a = intent();
  const f = fixture([a]);
  await open(f);
  await f.controller.openMcpAuth(serverId);
  const ui = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm authentication: Clear local credentials');
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b');
    await tick();
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\u001b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('Confirm authentication: Revoke remote credentials');
    ui.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    f.controller.selectMcpAuthOriginal(callerKey(a));
    f.defer(async () => ({
      intent: a,
      phase: 'pending',
      fact: {
        storeId: 'store',
        sessionId: 'a',
        command: {
          id: 'original',
          originStoreId: 'store',
          sessionId: 'a',
          subjectId: 'subject',
          requestDigest: a.requestDigest,
          status: 'applied',
          executionId: 'auth-e',
        },
        execution: {
          id: 'auth-e',
          originStoreId: 'store',
          sessionId: 'a',
          originCommandId: 'original',
          parentExecutionId: null,
          kind: 'job',
          definitionId: 'builtin.mcp.sources/mcp.auth.login',
          definitionVersion: '1',
          inputDigest: 'a'.repeat(64),
          status: 'running',
        },
        binding: {
          version: 1,
          executionId: 'auth-e',
          originCommandId: 'original',
          originalStoreId: 'store',
          sessionId: 'a',
          workspaceId: 'w',
          actionId: 'mcp.auth.login',
          serverId,
          inputDigest: 'a'.repeat(64),
        },
        phase: 'pending',
        authStatus: 'unknown',
        effectAttempted: null,
        reason: null,
      },
    }));
    await f.controller.lookupMcpAuth();
    await f.controller.cancelMcpAuth();
    expect(f.cancel).toEqual(['auth-e']);
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
});

test('late accepted authentication stays with its original Caller and cannot replace a later keyboard-selected original', async () => {
  const old = intent('old');
  const f = fixture([old]);
  await open(f);
  await f.controller.openMcpAuth(serverId);
  let release!: (value: import('../../src/tui').TuiCallerOutcome) => void;
  let submitted: TuiCallerIntent | undefined;
  f.port.mcpAuth!.submit = async (i) => {
    submitted = i;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const work = f.controller.requestMcpAuth('mcp.auth.login');
  await tick();
  f.controller.selectMcpAuthOriginal(callerKey(old));
  release({ intent: submitted!, phase: 'applied' });
  await work;
  expect(f.controller.state.mcpAuthOutcome?.intent.request.commandId).toBe('old');
  expect(f.controller.state.callers.has(callerKey(submitted!))).toBe(true);
  f.controller.selectMcpAuthOriginal(callerKey(submitted!));
  expect(f.controller.state.mcpAuthOutcome?.phase).toBe('pending');
  expect(f.counts().business).toBe(0);
  f.controller.dispose();
});

test('Chinese Ink authentication confirms explicitly and checks the second cold original without translating IDs or submitting on locale changes', async () => {
  const f = fixture();
  let language: 'zh-CN' | 'en-US' = 'zh-CN';
  f.port.preferences = {
    read: async () => ({
      revision: 'a'.repeat(64),
      language,
      resolvedLanguage: language,
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
    ui.stdin.write('\r');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('MCP 认证');
    expect(ui.lastFrame()).toContain('审查 登录');
    expect(ui.lastFrame()).toContain(serverId);
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('确认认证操作： 登录');
    expect(f.authPrepared()).toBe(0);
    expect(f.sent).toHaveLength(0);
    language = 'en-US';
    await f.controller.refreshPreferences();
    await tick();
    expect(ui.lastFrame()).toContain('Confirm authentication: Login');
    language = 'zh-CN';
    await f.controller.refreshPreferences();
    await tick();
    expect(ui.lastFrame()).toContain('确认认证操作： 登录');
    expect(f.authPrepared()).toBe(0);
    expect(f.sent).toHaveLength(0);
    ui.stdin.write('\r');
    await tick();
    expect(f.authPrepared()).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(ui.lastFrame()).toContain('认证申请待决');
    expect(ui.lastFrame()).toContain('auth-1');
    expect(f.counts().business).toBe(0);
  } finally {
    ui.unmount();
    f.controller.dispose();
  }
  const first = intent('external-first'),
    second = intent('external-second', 'foreign-Store', 'original-Session');
  const cold = fixture([first, second]);
  cold.port.preferences = f.port.preferences;
  await cold.controller.refreshPreferences();
  await open(cold);
  cold.sourceGone();
  await cold.controller.openMcpSources();
  const coldUi = render(<TuiSession controller={cold.controller} />);
  try {
    await tick();
    expect(coldUi.lastFrame()).toContain('原认证申请');
    coldUi.stdin.write('\r');
    await tick();
    coldUi.stdin.write('\u001b[B');
    await tick();
    coldUi.stdin.write('\r');
    await tick();
    expect(coldUi.lastFrame()).toContain('external-second');
    expect(coldUi.lastFrame()).toContain('foreign-Store');
    expect(coldUi.lastFrame()).toContain('original-Session');
    expect(cold.lookup).toHaveLength(0);
    coldUi.stdin.write('\u001b[A');
    await tick();
    coldUi.stdin.write('\u001b[A');
    await tick();
    expect(coldUi.lastFrame()).toContain('› 查询原认证申请');
    coldUi.stdin.write('\r');
    await tick();
    expect(cold.lookup).toEqual([second]);
    expect(cold.sent).toHaveLength(0);
    expect(cold.authPrepared()).toBe(0);
    expect(cold.counts()).toEqual({ minted: 0, business: 0 });
  } finally {
    coldUi.unmount();
    cold.controller.dispose();
  }
}, 5000);
