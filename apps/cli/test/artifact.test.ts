import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArtifact } from '../host';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('actual selected Bun executable is admitted with its exact digest on the native platform', () => {
  const executable = realpathSync(process.execPath);
  const digest = hash(readFileSync(executable));
  expect(() => verifyArtifact(executable, digest, true)).not.toThrow();
  expect(() => verifyArtifact(executable, '0'.repeat(64), true)).toThrow(
    'cli_artifact_identity_mismatch',
  );
});

test('artifact admission rejects relative paths, non-files and changed bytes; POSIX also requires executable mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-cli-artifact-'));
  try {
    const entrypoint = join(root, 'main.js');
    writeFileSync(entrypoint, 'original', { mode: 0o600 });
    const digest = hash(readFileSync(entrypoint));
    expect(() => verifyArtifact(entrypoint, digest, false)).not.toThrow();
    expect(() => verifyArtifact('main.js', digest, false)).toThrow('invalid_cli_artifact');
    expect(() => verifyArtifact(root, digest, false)).toThrow('cli_artifact_unavailable');
    if (process.platform !== 'win32')
      expect(() => verifyArtifact(entrypoint, digest, true)).toThrow('cli_artifact_unavailable');
    writeFileSync(entrypoint, 'changed');
    expect(() => verifyArtifact(entrypoint, digest, false)).toThrow(
      'cli_artifact_identity_mismatch',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
