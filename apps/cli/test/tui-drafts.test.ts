import { expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { createTuiDraftPort } from '../host/tui-draft-port';
import { openTuiDraftFile, TuiDraftError } from '../host/tui-drafts';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-tui-draft-');
  const profile = { dataRoot: join(root, 'data'), profile: 'draft' };
  const access = acquireProfileAccess(profile);
  mkdirSync(access.profilePath, { recursive: true, mode: 0o700 });
  const open = () =>
    openTuiDraftFile({
      access,
      acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
    });
  return {
    root,
    profile,
    access,
    open,
    path: join(access.profilePath, 'ui', 'tui.json'),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const scope = { storeId: 'original-store', workspaceId: 'workspace', sessionId: 'session' };
test('real shared admission, cold full text, exact scope and per-entry CAS preserve both instances and disjoint edits', async () => {
  const f = fixture();
  try {
    const a = f.open(),
      b = f.open();
    const text = '中'.repeat(3 * 1024 * 1024) + 'NINE_MIB_LAST_BYTE';
    expect(a.load(scope).text).toBe('');
    const old = b.load(scope);
    const saved = a.save(scope, '0', text);
    expect(b.load(scope).text).toBe(text);
    expect(() => b.save(scope, old.revision, 'concurrent original')).toThrow(
      'tui_draft_revision_conflict',
    );
    expect(a.load(scope).text).toBe(text);
    b.save({ ...scope, sessionId: 'other' }, '0', 'other original');
    expect(a.list().length).toBe(2);
    expect(a.load({ ...scope, storeId: 'new-store' }).text).toBe('');
    expect(a.readId(saved.id).storeId).toBe(scope.storeId);
    const short = acquireProfileDataLock(f.access, 'tui_private');
    expect(() => a.save(scope, saved.revision, 'busy')).toThrow('tui_draft_busy');
    short.release();
    await expect(
      createProfileBackup({ profile: f.profile, destinationRoot: join(f.root, 'backups') }),
    ).rejects.toMatchObject({ code: 'owner_busy' });
    a.close();
    b.close();
  } finally {
    f.close();
  }
});
test('debounced latest editor flush and accepted revision protect ABA and late edits; conflict retains original memory and disk', () => {
  const f = fixture();
  try {
    const codes: string[] = [];
    const a = createTuiDraftPort({
      file: f.open(),
      notify: (c) => codes.push(c),
      association: async () => 'current',
      delayMs: 10000,
    });
    a.port.edit(scope, 'first');
    const observed = a.port.version(scope);
    a.port.edit(scope, 'new');
    a.port.edit(scope, 'first');
    expect(a.port.accepted(scope, observed)).toBe(false);
    a.flush();
    expect(f.open().load(scope).text).toBe('first');
    const b = createTuiDraftPort({
      file: f.open(),
      notify: (c) => codes.push(c),
      association: async () => 'current',
    });
    expect(b.port.read(scope)).toBe('first');
    a.port.edit(scope, 'disk original');
    a.flush();
    b.port.edit(scope, 'memory original');
    b.flush();
    expect(b.port.read(scope)).toBe('memory original');
    expect(f.open().load(scope).text).toBe('disk original');
    expect(codes).toContain('tui_draft_revision_conflict');
    a.port.edit({ ...scope, sessionId: 'exit' }, 'last edit');
    a.close();
    expect(f.open().load({ ...scope, sessionId: 'exit' }).text).toBe('last edit');
    expect(b.close()).toBe(false);
    expect(b.port.read(scope)).toBe('memory original');
  } finally {
    f.close();
  }
});
test('malformed, links, permissions and capacity fail without recreating or truncating original bytes', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.access.profilePath, 'ui'), { mode: 0o700 });
    for (const bytes of ['{broken', JSON.stringify({ version: 2, revision: '0', drafts: [] })]) {
      writeFileSync(f.path, bytes, { mode: 0o600 });
      expect(() => f.open().save(scope, '0', 'new')).toThrow('tui_draft_storage_unavailable');
      expect(readFileSync(f.path, 'utf8')).toBe(bytes);
    }
    rmSync(f.path);
    symlinkSync(join(f.root, 'missing'), f.path);
    expect(() => f.open().save(scope, '0', 'new')).toThrow('tui_draft_storage_unavailable');
    expect(() => readFileSync(f.path)).toThrow();
    rmSync(f.path);
    const file = f.open();
    file.save(scope, '0', 'original');
    const bytes = readFileSync(f.path);
    linkSync(f.path, join(f.root, 'hard'));
    expect(() => file.load(scope)).toThrow('tui_draft_storage_unavailable');
    rmSync(join(f.root, 'hard'));
    chmodSync(f.path, 0o644);
    expect(() => file.load(scope)).toThrow('tui_draft_storage_unavailable');
    chmodSync(f.path, 0o600);
    expect(() => file.save(scope, '1', 'x'.repeat(17 * 1024 * 1024))).toThrow(
      'tui_draft_capacity_exceeded',
    );
    expect(readFileSync(f.path)).toEqual(bytes);
    file.close();
    expect(() => file.load(scope)).toThrow(TuiDraftError);
  } finally {
    f.close();
  }
});

test('rapid large text edits debounce document I/O and explicit exit flush stores every final byte', () => {
  const f = fixture();
  try {
    const file = f.open();
    let writes = 0;
    const adapter = createTuiDraftPort({
      file: {
        ...file,
        save(...args) {
          writes++;
          return file.save(...args);
        },
      },
      notify: () => {
        throw Error('unexpected draft failure');
      },
      association: async () => 'current',
      delayMs: 10000,
    });
    const body = '中'.repeat(3 * 1024 * 1024);
    for (let i = 0; i < 100; i++)
      adapter.port.edit(scope, body + 'revision ' + i + ' FINAL_FULL_TAIL');
    expect(writes).toBe(0);
    expect(adapter.port.version(scope)).toBe(100);
    adapter.close();
    expect(writes).toBe(1);
    expect(f.open().load(scope).text).toBe(body + 'revision 99 FINAL_FULL_TAIL');
  } finally {
    f.close();
  }
});

test('failed initial storage never masquerades as a saved empty editor at close', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.access.profilePath, 'ui'), { mode: 0o700 });
    writeFileSync(f.path, '{broken', { mode: 0o600 });
    const adapter = createTuiDraftPort({
      file: f.open(),
      notify: () => {},
      association: async () => 'unavailable',
    });
    expect(adapter.port.read(scope)).toBe('');
    adapter.port.edit(scope, 'only memory original');
    expect(adapter.close()).toBe(false);
    expect(adapter.port.read(scope)).toBe('only memory original');
    expect(readFileSync(f.path, 'utf8')).toBe('{broken');
  } finally {
    f.close();
  }
});
