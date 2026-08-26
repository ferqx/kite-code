import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  STANDALONE_WORKSPACE_ENTRYPOINTS_,
  verifyOssCandidate,
  writeOssCandidateArchive,
} from '../../scripts/release/oss-candidate';
import { createOssCandidateFixture } from './helpers/oss-candidate-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ordinary open-source candidate archive', () => {
  test('resolves every workspace export without entering node_modules symlinks', () => {
    const packageRoots = [
      'apps/kite-cli',
      'packages/agent-kernel',
      'packages/builtin-runtime',
      'packages/kite-app-contract',
      'packages/kite-local-runtime',
      'packages/runtime-client',
      'packages/runtime-contract',
      'packages/runtime-host',
      'packages/runtime-protocol',
      'packages/runtime-server',
      'packages/runtime-spi',
      'packages/runtime-storage-sqlite',
    ];
    for (const packageRoot of packageRoots) {
      const packageJson = JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf8')) as {
        name: string;
        exports: Record<string, string>;
      };
      for (const [subpath, target] of Object.entries(packageJson.exports)) {
        const specifier =
          subpath === '.' ? packageJson.name : `${packageJson.name}/${subpath.slice(2)}`;
        const expected = `${packageRoot}/${target.slice(2)}`;
        expect(STANDALONE_WORKSPACE_ENTRYPOINTS_[specifier]).toBe(expected);
        expect(expected).not.toContain('\\');
        expect(existsSync(expected)).toBe(true);
      }
    }
  });

  test('verifies the exact manifest, file checksums, and archive sidecar', async () => {
    const fixture = await createFixture('0.1.0');
    const verified = await verifyOssCandidate(fixture.archivePath, 'macos-arm64');
    expect(verified.manifest.integrity).toBe('sha256-only-unsigned');
    expect(verified.manifest.defaultCapabilities).toEqual({
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    });
    expect(verified.files.size).toBe(7);
  });

  test('rejects archive and payload tampering', async () => {
    const fixture = await createFixture('0.1.0');
    writeFileSync(
      `${fixture.archivePath}.sha256`,
      `${'0'.repeat(64)}  ${basename(fixture.archivePath)}\n`,
    );
    await expect(verifyOssCandidate(fixture.archivePath)).rejects.toThrow('sidecar');

    const restored = await createFixture('0.1.1');
    const bytes = readFileSync(restored.archivePath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(restored.archivePath, bytes);
    writeFileSync(
      `${restored.archivePath}.sha256`,
      `${createHash('sha256').update(bytes).digest('hex')}  ${basename(restored.archivePath)}\n`,
    );
    await expect(verifyOssCandidate(restored.archivePath)).rejects.toThrow();
  });

  test('writes byte-identical archives for the same manifest and files', async () => {
    const fixture = await createFixture('0.1.0');
    const verified = await verifyOssCandidate(fixture.archivePath, 'macos-arm64');
    const first = `${fixture.root}/repro-first.tar.gz`;
    const second = `${fixture.root}/repro-second.tar.gz`;

    await writeOssCandidateArchive({
      archivePath: first,
      manifest: verified.manifest,
      files: verified.files,
    });
    await writeOssCandidateArchive({
      archivePath: second,
      manifest: verified.manifest,
      files: verified.files,
    });

    expect(readFileSync(first)).toEqual(readFileSync(second));
  });
});

async function createFixture(version: string) {
  const fixture = await createOssCandidateFixture(version);
  const { root } = fixture;
  roots.push(root);
  return fixture;
}
