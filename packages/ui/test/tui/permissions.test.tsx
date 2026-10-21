import { expect, test } from 'bun:test';
import type { Change, SessionView } from '@kite-ai/client';
import { render } from 'ink-testing-library';
import {
  TuiController,
  type TuiPermissionIntent,
  type TuiPermissionOutcome,
  type TuiPermissionSnapshot,
  type TuiPort,
  TuiSession,
  type TuiSnapshot,
} from '../../src/tui';

const observed = (id = 'a', workspaceId = 'w'): TuiPermissionSnapshot => ({
  mode: {
    storeId: 'store',
    sessionId: id,
    scopeSessionId: id,
    mode: 'accept_edits',
    revision: '3',
    defaultMode: 'auto',
    defaultRevision: '2',
  },
  trust: {
    storeId: 'store',
    workspaceId,
    status: 'untrusted',
    trusted: false,
    revision: '4',
    canonicalIdentity: 'a'.repeat(64),
    externalReadScopeDigest: 'b'.repeat(64),
    readScopes: [{ kind: 'workspace', description: 'actual host scope' }],
  },
  grants: {
    storeId: 'store',
    sessionId: id,
    revision: '5',
    items: [],
    highWaterSeq: '0',
    upperSeq: '0',
    nextAfterSeq: null,
    snapshotCursor: '1',
  },
});
function fixture(workspaces: Record<string, string> = {}) {
  let count = 0;
  const sent: TuiPermissionIntent[] = [];
  const looked: TuiPermissionIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `c${++count}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: {
            id,
            rootSessionId: id,
            parentSessionId: null,
            workspaceId: workspaces[id] ?? 'w',
          },
          runs: [],
          executions: [],
          messages: [],
        } as unknown as SessionView,
        messages: [],
        interactions: [],
      }) as TuiSnapshot,
    submit: async () => {
      throw Error('no Model');
    },
    answer: async () => {
      throw Error('no answer');
    },
    cancel: async () => {
      throw Error('no cancel');
    },
    getCommand: async () => {
      throw Error('no command');
    },
    permissions: {
      read: async (id, workspaceId) => observed(id, workspaceId),
      submit: async (intent) => {
        sent.push(intent);
        return { intent, status: 'outcome_unknown' };
      },
      lookup: async (intent) => {
        looked.push(intent);
        return { intent, status: 'applied' };
      },
    },
  };
  return { port, sent, looked, controller: new TuiController(port) };
}

const modeChange = (sessionId = 'a', makeDefault = false): Change => ({
  cursor: '10',
  objectId: 'permission-change',
  revision: '1',
  sessionId,
  type: 'host_control.changed',
  payload: {
    kind: 'permission.mode',
    scope: `session:${sessionId}`,
    receipt: { status: 'applied', makeDefault },
  },
});

test('root, default and Workspace control events refresh inherited facts without opening a panel or borrowing another scope', async () => {
  const f = fixture();
  const readSession = f.port.readSession;
  f.port.readSession = async (id, signal) => {
    const snapshot = await readSession(id, signal);
    return {
      ...snapshot,
      view: {
        ...snapshot.view,
        session: { ...snapshot.view.session, rootSessionId: 'root', parentSessionId: 'root' },
      },
    };
  };
  let current = observed('child'),
    reads = 0;
  current.mode.scopeSessionId = 'root';
  f.port.permissions!.read = async () => {
    reads++;
    return current;
  };
  try {
    await f.controller.select('child');
    await f.controller.openPermissions();
    const initialReads = reads;
    current = { ...current, mode: { ...current.mode, mode: 'full', revision: '6' } };
    await f.controller.refreshPermissions(modeChange('root'));
    expect(f.controller.state.panel).toBe('permissions');
    expect(f.controller.state.permissions?.mode.mode).toBe('full');
    expect(reads).toBe(initialReads + 1);
    await f.controller.refreshPermissions(modeChange('foreign'));
    await f.controller.refreshPermissions({ ...modeChange('root'), type: 'execution.dispatching' });
    await f.controller.refreshPermissions({ ...modeChange('root'), payload: null });
    expect(reads).toBe(initialReads + 1);
    current = { ...current, mode: { ...current.mode, defaultMode: 'full', defaultRevision: '7' } };
    await f.controller.refreshPermissions(modeChange('foreign', true));
    expect(f.controller.state.permissions?.mode.defaultMode).toBe('full');
    const trustChange: Change = {
      ...modeChange(),
      sessionId: null,
      payload: {
        kind: 'workspace.trust',
        scope: 'workspace:other',
        receipt: { status: 'applied' },
      },
    };
    await f.controller.refreshPermissions(trustChange);
    expect(reads).toBe(initialReads + 2);
    current = {
      ...current,
      trust: { ...current.trust, trusted: true, status: 'trusted', revision: '8' },
    };
    f.controller.closePanel();
    await f.controller.refreshPermissions({
      ...trustChange,
      payload: { kind: 'workspace.trust', scope: 'workspace:w', receipt: { status: 'applied' } },
    });
    expect(reads).toBe(initialReads + 3);
    expect(f.controller.state.panel).toBeUndefined();
    expect(f.controller.state.permissions?.trust.trusted).toBe(true);
  } finally {
    f.controller.dispose();
  }
});

test('a root control event received while selecting a child is followed by current scoped facts', async () => {
  const f = fixture();
  const readSession = f.port.readSession;
  let finish!: (snapshot: TuiSnapshot) => void;
  f.port.readSession = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const facts = observed('child');
  facts.mode = { ...facts.mode, scopeSessionId: 'root', mode: 'full', revision: '6' };
  const requests: string[] = [];
  f.port.permissions!.read = async (sessionId) => {
    requests.push(sessionId);
    return facts;
  };
  try {
    const selecting = f.controller.select('child');
    await f.controller.refreshPermissions(modeChange('root'));
    expect(requests).toHaveLength(0);
    const snapshot = await readSession('child', new AbortController().signal);
    finish({
      ...snapshot,
      view: {
        ...snapshot.view,
        session: { ...snapshot.view.session, rootSessionId: 'root', parentSessionId: 'root' },
      },
    });
    await selecting;
    expect(requests).toEqual(['child']);
    expect(f.controller.state.permissions?.mode.mode).toBe('full');
    expect(f.controller.state.permissions?.mode.scopeSessionId).toBe('root');
    expect(f.controller.state.panel).toBeUndefined();
  } finally {
    f.controller.dispose();
  }
});

test('permission review survives unchanged refreshes and is withdrawn when the current controls change', async () => {
  const f = fixture();
  let current = observed();
  f.port.permissions!.read = async () => current;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
  await f.controller.select('a');
  await f.controller.openPermissions();
  const app = render(<TuiSession controller={f.controller} />);
  try {
    await tick();
    app.stdin.write('\r');
    await tick();
    expect(app.lastFrame()).toContain('Confirm original');
    current = { ...current, grants: { ...current.grants, snapshotCursor: '20' } };
    await f.controller.refreshPermissions();
    await tick();
    expect(app.lastFrame()).toContain('Confirm original');
    expect(f.sent).toHaveLength(0);
    current = { ...current, mode: { ...current.mode, mode: 'full', revision: '6' } };
    await f.controller.refreshPermissions(modeChange());
    await tick();
    expect(app.lastFrame()).not.toContain('Confirm original');
    expect(f.sent).toHaveLength(0);
    app.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(0);
    app.stdin.write('\r');
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      kind: 'permission.mode',
      request: { mode: 'full', ifRevision: '6' },
    });
  } finally {
    app.unmount();
    f.controller.dispose();
  }
});

test('an event refresh during a permission POST preserves its original result', async () => {
  const f = fixture();
  let finish!: (outcome: TuiPermissionOutcome) => void;
  let current = observed();
  f.port.permissions!.read = async () => current;
  f.port.permissions!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    const writing = f.controller.choosePermission({
      kind: 'mode',
      mode: 'full',
      makeDefault: false,
    });
    expect(f.sent).toHaveLength(1);
    current = { ...current, mode: { ...current.mode, mode: 'full', revision: '6' } };
    await f.controller.refreshPermissions(modeChange());
    expect(f.controller.state.permissions?.mode.mode).toBe('full');
    finish({ intent: f.sent[0]!, status: 'applied' });
    await writing;
    expect(f.controller.state.permissionOutcome?.status).toBe('applied');
    expect(f.sent).toHaveLength(1);
    expect(f.controller.state.permissions?.mode.revision).toBe('6');
  } finally {
    f.controller.dispose();
  }
});

test('background permission replies preserve unrelated errors and recover only their own unavailable facts', async () => {
  const f = fixture();
  let finish!: (facts: TuiPermissionSnapshot) => void;
  try {
    await f.controller.select('a');
    f.port.permissions!.read = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const reading = f.controller.refreshPermissions(modeChange());
    await f.controller.openModels();
    expect(f.controller.state.error).toBe('model_settings_unavailable');
    finish(observed());
    await reading;
    expect(f.controller.state.error).toBe('model_settings_unavailable');
    expect(f.controller.state.permissions?.mode.mode).toBe('accept_edits');
    f.port.permissions!.read = async () => {
      throw Error('current_permission_read_failed');
    };
    await f.controller.refreshPermissions(modeChange());
    expect(f.controller.state.permissions).toBeUndefined();
    expect(f.controller.state.error).toBe('model_settings_unavailable');
    await f.controller.openPermissions();
    expect(f.controller.state.error).toBe('current_permission_read_failed');
    f.port.permissions!.read = async () => observed();
    await f.controller.refreshPermissions(modeChange());
    expect(f.controller.state.permissions?.mode.mode).toBe('accept_edits');
    expect(f.controller.state.error).toBeUndefined();
  } finally {
    f.controller.dispose();
  }
});

test('late permission reads cannot replace a newer event, a new panel or another Session', async () => {
  const f = fixture();
  const pending: { signal: AbortSignal; finish: (facts: TuiPermissionSnapshot) => void }[] = [];
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    f.port.permissions!.read = (_id, _workspace, signal) =>
      new Promise((resolve) => {
        pending.push({ signal, finish: resolve });
      });
    const older = f.controller.refreshPermissions(modeChange());
    const newer = f.controller.refreshPermissions(modeChange());
    expect(pending[0]!.signal.aborted).toBe(true);
    const full = observed();
    full.mode = { ...full.mode, mode: 'full', revision: '6' };
    pending[1]!.finish(full);
    await newer;
    pending[0]!.finish(observed());
    await older;
    expect(f.controller.state.permissions?.mode.mode).toBe('full');
    const late = f.controller.refreshPermissions(modeChange());
    await f.controller.select('b');
    f.port.permissions!.read = async (id, workspace) => observed(id, workspace);
    await f.controller.openPermissions();
    pending[2]!.finish(full);
    await late;
    expect(pending[2]!.signal.aborted).toBe(true);
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.permissions?.mode.sessionId).toBe('b');
    expect(f.controller.state.permissions?.mode.mode).toBe('accept_edits');
  } finally {
    f.controller.dispose();
  }
});
test('permissions reset rereads original facts while observation is lost; only verified ready restores mutation eligibility', async () => {
  const f = fixture();
  let reads = 0;
  f.port.permissions!.read = async (id) => {
    reads++;
    return observed(id);
  };
  await f.controller.select('a');
  await f.controller.openPermissions();
  f.controller.observationUnavailable('server_reset');
  await f.controller.select('a');
  expect(f.controller.state.snapshotStale).toBe(false);
  await f.controller.openPermissions();
  expect(reads).toBe(3);
  expect(f.controller.state.permissions).toEqual(observed());
  expect(f.controller.state.stale).toBe(true);
  await f.controller.choosePermission({ kind: 'mode', mode: 'auto', makeDefault: false });
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.observationError).toBe('observation_unavailable:server_reset');
  f.controller.observationReady('store');
  expect(f.controller.state.stale).toBe(false);
  expect(f.controller.state.permissions).toEqual(observed());
  f.controller.dispose();
});

test('permissions retain original Session results across switching and query only the matching original ID', async () => {
  const f = fixture({ a: 'wa', b: 'wb' });
  try {
    await f.controller.select('a');
    await f.controller.routeCommand('/permissions');
    await f.controller.choosePermission({ kind: 'mode', mode: 'full', makeDefault: true });
    const original = f.sent[0]!;
    expect(original).toMatchObject({ sessionId: 'a', request: { commandId: 'c1' } });
    await f.controller.select('b');
    expect(f.controller.state.permissionOutcome).toBeUndefined();
    await f.controller.openPermissions();
    await f.controller.lookupPermission();
    expect(f.looked).toHaveLength(0);
    await f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ sessionId: 'b', request: { commandId: 'c2' } });
    await f.controller.select('a');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual({
      intent: original,
      status: 'outcome_unknown',
    });
    await f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(2);
    await f.controller.lookupPermission();
    expect(f.looked).toEqual([original]);
    expect(f.sent).toHaveLength(2);
    expect(f.controller.state.permissionOutcome).toEqual({ intent: original, status: 'applied' });
  } finally {
    f.controller.dispose();
  }
});

test('two original permission saves keep inverse late receipts in their scopes without replacing the current result', async () => {
  const f = fixture({ a: 'wa', b: 'wb' });
  const replies: ((outcome: TuiPermissionOutcome) => void)[] = [];
  f.port.permissions!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => replies.push(resolve));
  };
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    const a = f.controller.choosePermission({ kind: 'mode', mode: 'full', makeDefault: false });
    await f.controller.select('b');
    await f.controller.openPermissions();
    const b = f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(2);
    replies[1]!({ intent: f.sent[1]!, status: 'applied' });
    await b;
    const current = f.controller.state.permissionOutcome;
    const facts = f.controller.state.permissions;
    replies[0]!({ intent: f.sent[0]!, status: 'failed' });
    await a;
    expect(f.controller.state.permissionOutcome).toBe(current);
    expect(f.controller.state.permissions).toBe(facts);
    expect(current).toEqual({ intent: f.sent[1]!, status: 'applied' });
    await f.controller.select('a');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[0]!, status: 'failed' });
    const retry = f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toMatchObject({ sessionId: 'a', request: { commandId: 'c3' } });
    f.controller.dispose();
    replies[2]!({ intent: f.sent[2]!, status: 'applied' });
    await retry;
  } finally {
    f.controller.dispose();
  }
});

test('original permission lookup arriving after switching preserves the new result and its current read error', async () => {
  const f = fixture({ a: 'wa', b: 'wb' });
  let finish!: (outcome: TuiPermissionOutcome) => void;
  f.port.permissions!.lookup = (intent) => {
    f.looked.push(intent);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    await f.controller.choosePermission({ kind: 'mode', mode: 'auto', makeDefault: false });
    const querying = f.controller.lookupPermission();
    await f.controller.select('b');
    await f.controller.openPermissions();
    await f.controller.choosePermission({ kind: 'clear' });
    const current = f.controller.state.permissionOutcome;
    f.port.permissions!.read = async () => {
      throw Error('current_permission_read_failed');
    };
    await f.controller.openPermissions();
    finish({ intent: f.sent[0]!, status: 'failed' });
    await querying;
    expect(f.controller.state.sessionId).toBe('b');
    expect(f.controller.state.permissionOutcome).toEqual(current);
    expect(f.controller.state.error).toBe('current_permission_read_failed');
    expect(f.looked).toEqual([f.sent[0]!]);
    expect(f.sent).toHaveLength(2);
    f.port.permissions!.read = async (id, workspaceId) => observed(id, workspaceId);
    await f.controller.select('a');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[0]!, status: 'failed' });
  } finally {
    f.controller.dispose();
  }
});

test('workspace trust results follow the actual Workspace while Session results and all unresolved originals retain their scopes', async () => {
  const f = fixture({ c: 'other' });
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    await f.controller.choosePermission({ kind: 'mode', mode: 'auto', makeDefault: false });
    await f.controller.select('b');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toBeUndefined();
    await f.controller.choosePermission({ kind: 'trust', trusted: true });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toMatchObject({ kind: 'workspace.trust', workspaceId: 'w' });
    await f.controller.select('c');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toBeUndefined();
    await f.controller.lookupPermission();
    expect(f.looked).toHaveLength(0);
    await f.controller.select('a');
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome?.intent).toEqual(f.sent[0]);
    await f.controller.lookupPermission();
    expect(f.controller.state.permissionOutcome).toEqual({
      intent: f.sent[1]!,
      status: 'outcome_unknown',
    });
    await f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(2);
    await f.controller.lookupPermission();
    expect(f.looked).toEqual(f.sent);
    expect(f.sent).toHaveLength(2);
    await f.controller.choosePermission({ kind: 'clear' });
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toMatchObject({ kind: 'permission.grants.clear', sessionId: 'a' });
    await f.controller.lookupPermission();
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[2]!, status: 'applied' });
    expect(f.sent).toHaveLength(3);
  } finally {
    f.controller.dispose();
  }
});

test('closing and reopening permissions retires late display ownership but retains the exact saved original', async () => {
  const f = fixture();
  let finish!: (outcome: TuiPermissionOutcome) => void;
  let reads = 0;
  f.port.permissions!.read = async (id, workspaceId) => {
    reads++;
    return observed(id, workspaceId);
  };
  f.port.permissions!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    const writing = f.controller.choosePermission({ kind: 'clear' });
    f.controller.closePanel();
    await f.controller.lookupPermission();
    expect(f.looked).toHaveLength(0);
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome?.intent).toEqual(f.sent[0]);
    const original = f.controller.state.permissionOutcome;
    const currentReads = reads;
    finish({ intent: f.sent[0]!, status: 'applied' });
    await writing;
    expect(reads).toBe(currentReads);
    expect(f.controller.state.permissionOutcome).toBe(original);
    f.port.permissions!.lookup = async (intent) => {
      f.looked.push(intent);
      throw Error('original_lookup_unavailable');
    };
    await f.controller.lookupPermission();
    expect(f.looked).toEqual([f.sent[0]!]);
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[0]!, status: 'applied' });
    f.port.permissions!.lookup = async (intent) => {
      f.looked.push(intent);
      return { intent, status: 'outcome_unknown' };
    };
    await f.controller.lookupPermission();
    expect(f.looked).toEqual([f.sent[0]!, f.sent[0]!]);
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[0]!, status: 'applied' });
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual({ intent: f.sent[0]!, status: 'applied' });
    expect(f.sent).toHaveLength(1);
    const observation = f.controller.state.permissions;
    f.controller.closePanel();
    await f.controller.choosePermission(
      { kind: 'mode', mode: 'full', makeDefault: false },
      observation,
    );
    expect(f.sent).toHaveLength(1);
    await f.controller.openPermissions();
    const latestWriting = f.controller.choosePermission({
      kind: 'mode',
      mode: 'full',
      makeDefault: false,
    });
    // The second operation is retained even when its view is disposed before its reply.
    const latest = f.controller.state.permissionOutcome;
    f.controller.dispose();
    expect(f.sent).toHaveLength(2);
    finish({ intent: f.sent[1]!, status: 'applied' });
    await latestWriting;
    expect(f.controller.state.permissionOutcome).toBe(latest);
  } finally {
    f.controller.dispose();
  }
});

test('a later original permission lookup owns its result and cannot be downgraded by an earlier save or query', async () => {
  const f = fixture();
  let saved!: (outcome: TuiPermissionOutcome) => void;
  const queries: ((outcome: TuiPermissionOutcome) => void)[] = [];
  f.port.permissions!.submit = (intent) => {
    f.sent.push(intent);
    return new Promise((resolve) => {
      saved = resolve;
    });
  };
  f.port.permissions!.lookup = (intent) => {
    f.looked.push(intent);
    return new Promise((resolve) => queries.push(resolve));
  };
  try {
    await f.controller.select('a');
    await f.controller.openPermissions();
    const writing = f.controller.choosePermission({ kind: 'clear' });
    const earlier = f.controller.lookupPermission();
    const later = f.controller.lookupPermission();
    queries[1]!({ intent: f.sent[0]!, status: 'applied' });
    await later;
    const current = f.controller.state.permissionOutcome;
    queries[0]!({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await earlier;
    saved({ intent: f.sent[0]!, status: 'outcome_unknown' });
    await writing;
    expect(current).toEqual({ intent: f.sent[0]!, status: 'applied' });
    expect(f.controller.state.permissionOutcome).toBe(current);
    await f.controller.openPermissions();
    expect(f.controller.state.permissionOutcome).toEqual(current);
    expect(f.looked).toEqual([f.sent[0]!, f.sent[0]!]);
    expect(f.sent).toHaveLength(1);
  } finally {
    f.controller.dispose();
  }
});

test('fresh permission observation freezes original CAS/default/trust scope; unknown only lookup and no implicit mutation', async () => {
  const f = fixture();
  await f.controller.select('a');
  await f.controller.routeCommand('/permissions');
  const old = f.controller.state.permissions!;
  expect(f.sent).toHaveLength(0);
  f.port.permissions!.read = async () => ({
    ...observed(),
    mode: { ...observed().mode, revision: '9' },
  });
  await f.controller.openPermissions();
  await f.controller.choosePermission({ kind: 'mode', mode: 'full', makeDefault: true }, old);
  expect(f.sent[0]).toMatchObject({
    sessionId: 'a',
    request: { ifRevision: '3', ifDefaultRevision: '2', makeDefault: true, mode: 'full' },
  });
  await f.controller.choosePermission({ kind: 'clear' });
  expect(f.sent).toHaveLength(1);
  await f.controller.lookupPermission();
  expect(f.sent).toHaveLength(1);
  await f.controller.choosePermission({ kind: 'trust', trusted: true });
  expect(f.sent[1]).toMatchObject({
    workspaceId: 'w',
    request: {
      ifRevision: '4',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
    },
  });
  f.controller.dispose();
});
test('closed and changed target permission reads abort or cannot publish; child inherited mode cannot be written', async () => {
  const f = fixture();
  await f.controller.select('a');
  let finish!: (v: TuiPermissionSnapshot) => void;
  let signal!: AbortSignal;
  f.port.permissions!.read = (_id, _w, s) => {
    signal = s;
    return new Promise((r) => {
      finish = r;
    });
  };
  const work = f.controller.openPermissions();
  await Promise.resolve();
  f.controller.closePanel();
  expect(signal.aborted).toBe(true);
  finish(observed());
  await work;
  expect(f.controller.state.permissions).toBeUndefined();
  f.port.permissions!.read = async (id) => ({
    ...observed(id),
    mode: { ...observed(id).mode, scopeSessionId: 'parent' },
  });
  await f.controller.select('child');
  await f.controller.openPermissions();
  await f.controller.choosePermission({ kind: 'mode', mode: 'full', makeDefault: false });
  expect(f.sent).toHaveLength(0);
  expect(f.controller.state.error).toBe('child_mode_inherited');
  f.controller.dispose();
});
