import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readConfigurationFile, updateConfigurationFile } from '@kite-ai/agent/config';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { openTuiPreferenceFile } from '../host/tui-preferences';

function fixture() {
  const root = mkdtempSync('/private/tmp/kite-tui-prefs-');
  const profile = { dataRoot: join(root, 'data'), profile: 'prefs' };
  const access = acquireProfileAccess(profile);
  mkdirSync(access.profilePath, { mode: 0o700, recursive: true });
  return {
    root,
    profile,
    access,
    path: join(access.profilePath, 'ui/preferences.jsonc'),
    open: (deviceLocale = 'en-GB') => openTuiPreferenceFile({ access, deviceLocale }),
    close() {
      access.lock.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('missing preferences resolve system locale without publication; real save/reopen preserves exact revision and unrelated JSONC', async () => {
  const f = fixture();
  try {
    const a = f.open('zh-Hant-TW');
    const missing = a.read();
    expect(missing).toMatchObject({
      language: 'system',
      resolvedLanguage: 'zh-CN',
      colorPreset: 'teal',
      theme: 'dark',
    });
    expect(missing.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(f.path)).toBe(false);
    const first = a.save({
      expectedRevision: missing.revision,
      key: 'colorPreset',
      value: 'purple',
    });
    expect(first.colorPreset).toBe('purple');
    expect(first.revision).not.toBe(missing.revision);
    a.close();
    const b = f.open('fr-FR');
    expect(b.read()).toMatchObject({
      language: 'system',
      resolvedLanguage: 'en-US',
      colorPreset: 'purple',
    });
    b.close();
    const original =
      '// preserve exact comment\n{"language":"system", "colorPreset":"purple", "theme":"light", "future":{"raw":"unchanged"}}\n';
    writeFileSync(f.path, original, { mode: 0o600 });
    const c = f.open('en-US');
    const before = c.read();
    const saved = c.save({ expectedRevision: before.revision, key: 'language', value: 'zh-CN' });
    expect(saved).toMatchObject({
      language: 'zh-CN',
      resolvedLanguage: 'zh-CN',
      colorPreset: 'purple',
      theme: 'light',
    });
    const bytes = readFileSync(f.path, 'utf8');
    expect(bytes).toContain('// preserve exact comment');
    expect(bytes).toContain('"future":{"raw":"unchanged"}');
    expect(readConfigurationFile({ path: f.path }).etag).toBe(saved.revision);
    expect(f.open('en-US').read()).toEqual(saved);
    await expect(
      createProfileBackup({ profile: f.profile, destinationRoot: join(f.root, 'backups') }),
    ).rejects.toMatchObject({ code: 'owner_busy' });
    c.close();
  } finally {
    f.close();
  }
});
test('stale revision and actual configuration lock reject once, preserving the concurrent original bytes', () => {
  const f = fixture();
  try {
    const a = f.open(),
      b = f.open();
    const old = b.read();
    const current = a.save({
      expectedRevision: a.read().revision,
      key: 'language',
      value: 'en-US',
    });
    const original = readFileSync(f.path);
    expect(() =>
      b.save({ expectedRevision: old.revision, key: 'colorPreset', value: 'blue' }),
    ).toThrow('tui_preferences_conflict');
    expect(readFileSync(f.path)).toEqual(original);
    let checked = false;
    updateConfigurationFile({
      path: f.path,
      ifMatch: current.revision,
      operations: [{ kind: 'set', path: ['future'], value: true }],
      validateCandidate() {
        checked = true;
        expect(() =>
          a.save({ expectedRevision: current.revision, key: 'colorPreset', value: 'cyan' }),
        ).toThrow('tui_preferences_busy');
        expect(readFileSync(f.path)).toEqual(original);
      },
    });
    expect(checked).toBe(true);
    expect(a.read().colorPreset).toBe('teal');
    a.close();
    b.close();
    expect(() => a.read()).toThrow('tui_preferences_unavailable');
  } finally {
    f.close();
  }
});
test('malformed documents, invalid finite values and file/path authority failures never repair or overwrite original data', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.access.profilePath, 'ui'), { mode: 0o700 });
    for (const bytes of [
      '{broken',
      '{"language":"other"}',
      '{"colorPreset":"red"}',
      '{"theme":"other"}',
      '{"language":42}',
      '{"language":null}',
      '{"colorPreset":null}',
      '{"theme":null}',
    ]) {
      writeFileSync(f.path, bytes, { mode: 0o600 });
      const a = f.open();
      expect(() => a.read()).toThrow('tui_preferences_invalid');
      expect(() =>
        a.save({ expectedRevision: 'a'.repeat(64), key: 'language', value: 'en-US' }),
      ).toThrow('tui_preferences_invalid');
      expect(readFileSync(f.path, 'utf8')).toBe(bytes);
      a.close();
    }
    writeFileSync(f.path, '{}', { mode: 0o600 });
    const a = f.open();
    const revision = a.read().revision;
    for (const edit of [
      { expectedRevision: revision, key: 'theme', value: 'light' },
      { expectedRevision: revision, key: 'language', value: 'other' },
      { expectedRevision: revision, key: 'language', value: 'en-US', owner: 'forged' },
    ])
      expect(() => a.save(edit as never)).toThrow('tui_preferences_invalid');
    expect(readFileSync(f.path, 'utf8')).toBe('{}');
    chmodSync(f.path, 0o644);
    expect(() => a.read()).toThrow('tui_preferences_unavailable');
    chmodSync(f.path, 0o600);
    rmSync(f.path);
    const outside = join(f.root, 'outside');
    writeFileSync(outside, '{}', { mode: 0o600 });
    symlinkSync(outside, f.path);
    expect(() => a.read()).toThrow('tui_preferences_unavailable');
    rmSync(f.path);
    linkSync(outside, f.path);
    expect(() => a.save({ expectedRevision: revision, key: 'language', value: 'en-US' })).toThrow(
      'tui_preferences_unavailable',
    );
    expect(readFileSync(outside, 'utf8')).toBe('{}');
    rmSync(f.path);
    rmSync(join(f.access.profilePath, 'ui'), { recursive: true });
    const other = join(f.root, 'other');
    mkdirSync(other, { mode: 0o700 });
    symlinkSync(other, join(f.access.profilePath, 'ui'));
    expect(() => a.save({ expectedRevision: revision, key: 'language', value: 'en-US' })).toThrow(
      'tui_preferences_unavailable',
    );
    expect(existsSync(join(other, 'preferences.jsonc'))).toBe(false);
    a.close();
  } finally {
    f.close();
  }
});

test('only the original live profile access can read or publish preferences', () => {
  const f = fixture();
  try {
    const file = f.open();
    const original = file.save({
      expectedRevision: file.read().revision,
      key: 'language',
      value: 'en-US',
    });
    const bytes = readFileSync(f.path);
    const forged = openTuiPreferenceFile({ access: { ...f.access }, deviceLocale: 'en-US' });
    expect(() => forged.read()).toThrow('tui_preferences_unavailable');
    expect(() =>
      forged.save({ expectedRevision: original.revision, key: 'colorPreset', value: 'blue' }),
    ).toThrow('tui_preferences_unavailable');
    f.access.lock.release();
    expect(() => file.read()).toThrow('tui_preferences_unavailable');
    expect(() =>
      file.save({ expectedRevision: original.revision, key: 'colorPreset', value: 'blue' }),
    ).toThrow('tui_preferences_unavailable');
    expect(readFileSync(f.path)).toEqual(bytes);
    file.close();
    forged.close();
  } finally {
    f.close();
  }
});

test('file owner seals the original profile access instead of following a caller-mutated input alias', () => {
  const f = fixture();
  const other = acquireProfileAccess({ ...f.profile, profile: 'other' });
  mkdirSync(other.profilePath, { recursive: true, mode: 0o700 });
  try {
    const input = { access: f.access, deviceLocale: 'en-US' };
    const file = openTuiPreferenceFile(input);
    const saved = file.save({
      expectedRevision: file.read().revision,
      key: 'language',
      value: 'zh-CN',
    });
    const bytes = readFileSync(f.path);
    input.access = other;
    expect(file.read()).toEqual(saved);
    expect(existsSync(join(other.profilePath, 'ui/preferences.jsonc'))).toBe(false);
    f.access.lock.release();
    expect(() => file.read()).toThrow('tui_preferences_unavailable');
    expect(() =>
      file.save({ expectedRevision: saved.revision, key: 'colorPreset', value: 'blue' }),
    ).toThrow('tui_preferences_unavailable');
    expect(readFileSync(f.path)).toEqual(bytes);
    file.close();
  } finally {
    other.lock.release();
    f.close();
  }
});
