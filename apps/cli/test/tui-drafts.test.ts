import { expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { privateDirectory } from '../../../tests/fixtures/test-filesystem';
import { createTuiDraftPort } from '../host/tui-draft-port';
import { openTuiDraftFile, TuiDraftError } from '../host/tui-drafts';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tui-draft-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'draft' };
  const access = acquireProfileAccess(profile);
  privateDirectory(access.profilePath);
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
    privateDirectory(join(f.access.profilePath, 'ui'));
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
    privateDirectory(join(f.access.profilePath, 'ui'));
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

test('independent same-scope editors coalesce only a locked identical full draft at exit', () => {
  const f = fixture();
  try {
    const codes: string[] = [];
    const editor = () =>
      createTuiDraftPort({
        file: f.open(),
        notify: (code) => codes.push(code),
        association: async () => 'current',
        delayMs: 10000,
      });
    const a = editor(),
      b = editor();
    expect(a.port.read(scope)).toBe('');
    expect(b.port.read(scope)).toBe('');
    // Both UI instances clear their own unchanged empty draft on acceptance.
    expect(b.port.accepted(scope, b.port.version(scope))).toBe(true);
    const bytes = readFileSync(f.path);
    expect(a.port.accepted(scope, a.port.version(scope))).toBe(true);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(a.close()).toBe(true);
    expect(b.close()).toBe(true);
    const c = editor(),
      d = editor();
    const fullText = 'same full Markdown\n\n中🙂  tail\n';
    c.port.edit(scope, fullText);
    d.port.edit(scope, fullText);
    expect(c.flush()).toBe(true);
    const saved = f.open().load(scope),
      savedBytes = readFileSync(f.path);
    expect(d.close()).toBe(true);
    expect(f.open().load(scope)).toEqual(saved);
    expect(readFileSync(f.path)).toEqual(savedBytes);
    expect(codes).toEqual([]);
    expect(c.close()).toBe(true);
  } finally {
    f.close();
  }
});

test('same-content coalescing never clears a different concurrent draft or adopts foreign scope', () => {
  const f = fixture();
  try {
    const codes: string[] = [];
    const a = createTuiDraftPort({
      file: f.open(),
      notify: (code) => codes.push(code),
      association: async () => 'current',
      delayMs: 10000,
    });
    expect(a.port.read(scope)).toBe('');
    const file = f.open();
    const foreign = { ...scope, sessionId: 'other' };
    file.save(foreign, '0', '');
    const original = file.save(scope, '0', 'other editor unsent body\n');
    const bytes = readFileSync(f.path);
    expect(a.port.accepted(scope, a.port.version(scope))).toBe(false);
    expect(a.close()).toBe(false);
    expect(file.load(scope)).toEqual(original);
    expect(readFileSync(f.path)).toEqual(bytes);
    expect(codes).toContain('tui_draft_revision_conflict');
    expect(() => file.save(scope, '99', original.text)).toThrow('tui_draft_revision_conflict');
    expect(file.load(foreign).text).toBe('');
    expect(file.load({ ...scope, storeId: 'other-store' }).revision).toBe('0');
    expect(file.load({ ...scope, workspaceId: 'other-workspace' }).revision).toBe('0');
    file.close();
  } finally {
    f.close();
  }
});
