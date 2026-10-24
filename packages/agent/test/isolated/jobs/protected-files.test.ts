import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { launchIdentity } from '../../../src/jobs/launch-identity';
import { captureProtectedFiles } from '../../../src/jobs/protected-files';

test('private names preserve strict directory identity without reading or hashing a private file', () => {
  const root = temporaryDirectory('kite-protected-file-');
  try {
    const file = join(root, 'auth.json');
    writeFileSync(file, 'synthetic-private-material', { mode: 0o600 });
    expect(() => launchIdentity(file)).toThrow('invalid_confined_path');
    const protection = captureProtectedFiles([file]);
    expect(protection.files[0]!.parent.digest).toBeNull();
    expect(JSON.stringify(protection.files)).not.toContain('synthetic-private-material');
    protection.verify();
    chmodSync(file, 0);
    protection.verify();
    chmodSync(file, 0o600);
    const rotated = join(root, 'rotated');
    writeFileSync(rotated, 'synthetic-refreshed-material', { mode: 0o600 });
    renameSync(rotated, file);
    protection.verify();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing credential directory may appear later while private canonical redirection still rejects', () => {
  const root = temporaryDirectory('kite-future-protected-file-');
  try {
    const home = join(root, 'codex'),
      file = join(home, 'auth.json');
    const protection = captureProtectedFiles([file]);
    protection.verify();
    mkdirSync(home);
    writeFileSync(file, 'synthetic-late-secret');
    protection.verify();
    const moved = join(root, 'elsewhere');
    renameSync(home, moved);
    symlinkSync(moved, home);
    expect(() => protection.verify()).toThrow('shell_protected_file_changed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
