import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  STANDALONE_WORKSPACE_ENTRYPOINTS_,
  verifyOssCandidate,
  writeOssCandidateArchive,
} from '../../scripts/release/oss-candidate';
import { createOssCandidateFixture } from './helpers/oss-candidate-fixture';

const roots: string[] = [];
const MACOS_FIXTURE_TARGET = {
  id: 'macos-arm64',
  os: 'darwin',
  arch: 'arm64',
  executableSuffix: '',
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ordinary open-source candidate archive', () => {
  test('keeps the source Service entrypoint directly executable by the manager', () => {
    const entrypoint = 'scripts/release/entrypoints/service.ts';
    expect(readFileSync(entrypoint, 'utf8')).toStartWith('#!/usr/bin/env bun\n');
    if (process.platform !== 'win32') expect(lstatSync(entrypoint).mode & 0o111).not.toBe(0);
  });

  test('resolves every workspace export without entering node_modules symlinks', () => {
    const packageRoots = [
      'apps/kite-cli',
      'apps/kite-service',
      'packages/agent-api-contract',
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
    expect(verified.files.size).toBe(19);
    expect(verified.files.has('payload/web/api-docs/openapi.json')).toBe(true);
    expect(verified.manifest.releaseSlots).toEqual(
      expect.objectContaining({
        coordinator: {
          entrypoint: 'bin/kite-coordinator',
          identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        worker: {
          entrypoint: 'bin/kite-worker',
          identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        gateway: {
          entrypoint: 'bin/kite-web-gateway',
          identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        web: {
          entrypoint: 'payload/web/index.html',
          identity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      }),
    );
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

  test('rejects companion release-slot aliases', async () => {
    const fixture = await createFixture('0.1.0');
    const manifest = structuredClone(fixture.manifest);
    if (manifest.releaseSlots === undefined) throw new Error('fixture omitted release slots');
    manifest.releaseSlots.coordinator.entrypoint = 'bin/kite';
    await writeOssCandidateArchive({
      archivePath: `${fixture.root}/aliased-companion.tar.gz`,
      manifest,
      files: fixture.files,
    });
    await expect(verifyOssCandidate(`${fixture.root}/aliased-companion.tar.gz`)).rejects.toThrow(
      'fixed companion path',
    );
  });

  test('rejects a missing or aliased Web payload slot', async () => {
    const fixture = await createFixture('0.1.0');
    const missing = structuredClone(fixture.manifest);
    if (missing.releaseSlots === undefined) throw new Error('fixture omitted release slots');
    missing.releaseSlots.web = { entrypoint: null, identity: null };
    await writeOssCandidateArchive({
      archivePath: `${fixture.root}/missing-web.tar.gz`,
      manifest: missing,
      files: fixture.files,
    });
    await expect(verifyOssCandidate(`${fixture.root}/missing-web.tar.gz`)).rejects.toThrow(
      'fixed payload path',
    );

    const aliased = structuredClone(fixture.manifest);
    if (aliased.releaseSlots === undefined) throw new Error('fixture omitted release slots');
    aliased.releaseSlots.web.entrypoint = 'docs/RELEASE_NOTES.md';
    aliased.releaseSlots.web.identity = fixture.manifest.files.find(
      (entry) => entry.path === 'docs/RELEASE_NOTES.md',
    )!.sha256;
    await writeOssCandidateArchive({
      archivePath: `${fixture.root}/aliased-web.tar.gz`,
      manifest: aliased,
      files: fixture.files,
    });
    await expect(verifyOssCandidate(`${fixture.root}/aliased-web.tar.gz`)).rejects.toThrow(
      'fixed payload path',
    );
  });

  test('rejects a Web payload without the bundled Agent API contract', async () => {
    const fixture = await createFixture('0.1.0');
    const manifest = structuredClone(fixture.manifest);
    manifest.files = manifest.files.filter(
      (entry) => entry.path !== 'payload/web/api-docs/openapi.json',
    );
    const files = new Map(fixture.files);
    files.delete('payload/web/api-docs/openapi.json');
    const archivePath = `${fixture.root}/missing-agent-api-contract.tar.gz`;
    await writeOssCandidateArchive({ archivePath, manifest, files });

    await expect(verifyOssCandidate(archivePath)).rejects.toThrow(
      'missing its bundled Agent API contract',
    );
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
  const fixture = await createOssCandidateFixture(version, MACOS_FIXTURE_TARGET);
  const { root } = fixture;
  roots.push(root);
  return fixture;
}
