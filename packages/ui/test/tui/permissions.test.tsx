import { expect, test } from 'bun:test';
import type { SessionView } from '@kite-ai/client';
import {
  TuiController,
  type TuiPermissionIntent,
  type TuiPermissionSnapshot,
  type TuiPort,
  type TuiSnapshot,
} from '../../src/tui';

const observed = (id = 'a'): TuiPermissionSnapshot => ({
  mode: {
    storeId: 'store',
    sessionId: id,
    scopeSessionId: id,
    mode: 'ask',
    revision: '3',
    defaultMode: 'auto',
    defaultRevision: '2',
  },
  trust: {
    storeId: 'store',
    workspaceId: 'w',
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
function fixture() {
  let count = 0;
  const sent: TuiPermissionIntent[] = [];
  const port: TuiPort = {
    storeId: 'store',
    nextCommandId: () => `c${++count}`,
    listSessions: async () => [],
    readSession: async (id) =>
      ({
        storeId: 'store',
        view: {
          storeId: 'store',
          session: { id, rootSessionId: id, parentSessionId: null, workspaceId: 'w' },
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
      read: async (id) => observed(id),
      submit: async (intent) => {
        sent.push(intent);
        return { intent, status: 'outcome_unknown' };
      },
      lookup: async (intent) => ({ intent, status: 'applied' }),
    },
  };
  return { port, sent, controller: new TuiController(port) };
}
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
  expect(reads).toBe(2);
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
