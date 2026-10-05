import { expect, test } from 'bun:test';
import type { Command, SessionView } from '@kite-ai/client';
import { parseTuiCommand, TuiController, type TuiDraftPort, type TuiPort } from '../../src/tui';

function fixture() {
  let resolve!: (command: Command) => void;
  let writes = 0;
  const scope = { storeId: 'store', workspaceId: 'workspace', sessionId: 'a' };
  const rows = new Map<string, string>([['a', 'cold original']]);
  const versions = new Map<string, number>();
  const drafts: TuiDraftPort = {
    flush() {
      return true;
    },
    read: (s) => rows.get(s.sessionId) ?? '',
    edit(s, text) {
      rows.set(s.sessionId, text);
      versions.set(s.sessionId, (versions.get(s.sessionId) ?? 0) + 1);
    },
    version: (s) => versions.get(s.sessionId) ?? 0,
    accepted(s, v) {
      if ((versions.get(s.sessionId) ?? 0) !== v) return false;
      rows.set(s.sessionId, '');
      return true;
    },
    list: () => [{ ...scope, id: 'a'.repeat(64), revision: '1' }],
    original: async () => ({
      ...scope,
      id: 'a'.repeat(64),
      revision: '1',
      text: 'old Store original\u001b[2J',
      association: 'unavailable',
    }),
  };
  const port: TuiPort = {
    storeId: 'store',
    drafts,
    nextCommandId: () => 'command',
    listSessions: async () => [],
    readSession: async (id) => ({
      storeId: 'store',
      view: {
        storeId: 'store',
        snapshotCursor: '1',
        session: { id, workspaceId: 'workspace', contextSelectionId: 'context' },
        runs: [],
        executions: [],
        messages: [],
      } as unknown as SessionView,
      messages: [],
      interactions: [],
    }),
    submit: async () => {
      writes++;
      return new Promise<Command>((done) => (resolve = done));
    },
    answer: async () => {
      throw Error('unused');
    },
    cancel: async () => {
      throw Error('unused');
    },
    getCommand: async () => {
      throw Error('unused');
    },
  };
  return {
    c: new TuiController(port),
    port,
    rows,
    writes: () => writes,
    accept() {
      resolve({
        id: 'command',
        sessionId: 'a',
        originStoreId: 'store',
        kind: 'run.start',
        status: 'accepted',
        receipt: {},
        cancelRequestedAt: null,
      });
    },
  };
}
test('cold scoped hydration, switch save and late accepted result retain new editor including ABA text', async () => {
  const f = fixture();
  await f.c.select('a');
  expect(f.c.state.draft).toBe('cold original');
  f.c.setDraft('submitted');
  const pending = f.c.send();
  f.c.setDraft('new');
  f.c.setDraft('submitted');
  f.accept();
  await pending;
  expect(f.c.state.draft).toBe('submitted');
  expect(f.rows.get('a')).toBe('submitted');
  await f.c.select('b');
  expect(f.c.state.draft).toBe('');
  f.c.setDraft('b original');
  await f.c.select('a');
  expect(f.c.state.draft).toBe('submitted');
  const next = f.c.send();
  f.accept();
  await next;
  expect(f.c.state.draft).toBe('');
  expect(f.rows.get('a')).toBe('');
  expect(f.rows.get('b')).toBe('b original');
  f.c.dispose();
});
test('original draft directory is read-only and unavailable associations never bind/send or replace composer', async () => {
  const f = fixture();
  await f.c.select('a');
  f.c.setDraft('current original');
  await f.c.routeCommand('/drafts');
  expect(f.c.state.notice).toContain('Store store');
  await f.c.routeCommand('/draft ' + 'a'.repeat(64));
  expect(f.c.state.notice).toContain('association unavailable');
  expect(f.c.state.notice).toContain('old Store original');
  expect(f.c.state.draft).toBe('current original');
  expect(f.writes()).toBe(0);
  expect(() => parseTuiCommand('/draft ../original')).toThrow();
  expect(() => parseTuiCommand('/drafts extra')).toThrow();
  f.c.dispose();
});
test('storage unavailable preserves editable input and unknown outcome retains exact original', async () => {
  const f = fixture();
  f.port.drafts!.read = () => {
    throw Error('broken');
  };
  f.port.drafts!.edit = () => {
    throw Error('broken');
  };
  f.port.submit = async () => {
    throw Error('network');
  };
  await f.c.select('a');
  f.c.setDraft('memory original');
  await f.c.send();
  expect(f.c.state.draft).toBe('memory original');
  expect(f.c.state.intent?.phase).toBe('unknown');
  f.c.dispose();
});

test('applied Session deletion does not clear or rebind the original unsent draft', async () => {
  const f = fixture();
  f.port.readSession = async (id) => ({
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'workspace',
        rootSessionId: id,
        parentSessionId: null,
        controlRevision: '1',
      },
      runs: [],
      executions: [],
      messages: [],
    } as unknown as SessionView,
    messages: [],
    interactions: [],
  });
  f.port.management = {
    manage: async (intent) => ({ intent, status: 'applied' }),
    lookup: async (intent) => ({ intent, status: 'applied' }),
    newSession: async () => 'new',
    quit() {},
    readContext: async () => {
      throw Error('unused');
    },
  };
  await f.c.select('a');
  f.c.setDraft('unsent original before deletion');
  await f.c.routeCommand('/session delete confirm');
  expect(f.rows.get('a')).toBe('unsent original before deletion');
  await f.c.select('new');
  expect(f.c.state.draft).toBe('');
  expect(f.rows.get('a')).toBe('unsent original before deletion');
  expect(f.writes()).toBe(0);
  f.c.dispose();
});

test('unknown slash management and read-only panel commands preserve original unsent text; late consumed command cannot clear a new edit', async () => {
  const f = fixture();
  f.port.readSession = async (id) => ({
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'workspace',
        rootSessionId: id,
        parentSessionId: null,
        controlRevision: '1',
      },
      runs: [],
      executions: [],
      messages: [],
    } as unknown as SessionView,
    messages: [],
    interactions: [],
  });
  f.port.management = {
    manage: async (intent) => ({ intent, status: 'outcome_unknown' }),
    lookup: async (intent) => ({ intent, status: 'outcome_unknown' }),
    newSession: async () => 'new',
    quit() {},
    readContext: async () => {
      throw Error('unused');
    },
  };
  await f.c.select('a');
  f.c.setDraft('/session rename original');
  await f.c.send();
  expect(f.c.state.draft).toBe('/session rename original');
  f.c.setDraft('original separate composer');
  await f.c.routeCommand('/help');
  expect(f.c.state.draft).toBe('original separate composer');
  let finish!: () => void;
  f.port.management.manage = (intent) =>
    new Promise((resolve) => {
      finish = () => resolve({ intent, status: 'applied' });
    });
  f.port.nextCommandId = () => 'later-command';
  f.c.setDraft('/session rename next');
  const pending = f.c.send();
  f.c.setDraft('concurrent new text');
  finish();
  await pending;
  expect(f.c.state.draft).toBe('concurrent new text');
  expect(f.rows.get('a')).toBe('concurrent new text');
  f.c.dispose();
});

test('accepted Fork consumes only its original typed slash draft after selection changes, so cold inputs cannot append to an accepted command', async () => {
  const f = fixture();
  f.port.readSession = async (id) => ({
    storeId: 'store',
    view: {
      storeId: 'store',
      snapshotCursor: '1',
      session: {
        id,
        workspaceId: 'workspace',
        rootSessionId: id,
        parentSessionId: null,
        controlRevision: '1',
        contextSelectionId: 'context',
      },
      runs: [],
      executions: [],
      messages: [],
    } as unknown as SessionView,
    messages: [],
    interactions: [],
  });
  f.port.management = {
    manage: async (intent) => ({ intent, status: 'applied' }),
    lookup: async (intent) => ({ intent, status: 'applied' }),
    newSession: async () => 'new',
    quit() {},
    readContext: async () => {
      throw Error('unused');
    },
  };
  await f.c.select('a');
  f.c.setDraft('/session fork chosen title');
  await f.c.send();
  expect(f.c.state.sessionId).not.toBe('a');
  expect(f.rows.get('a')).toBe('');
  expect(f.c.state.draft).toBe('');
  await f.c.select('a');
  expect(f.c.state.draft).toBe('');
  expect(f.writes()).toBe(0);
  f.c.dispose();
});
