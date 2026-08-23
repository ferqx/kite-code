import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ossCandidateManifestSchema,
  writeOssCandidateArchive,
} from '../../../scripts/release/oss-candidate';

export async function createOssCandidateFixture(
  version: string,
  target: {
    id: 'macos-arm64' | 'linux-x64';
    os: 'darwin' | 'linux';
    arch: 'arm64' | 'x64';
  } = { id: 'macos-arm64', os: 'darwin', arch: 'arm64' },
) {
  const root = mkdtempSync(join(tmpdir(), 'kite-oss-candidate-test-'));
  const archivePath = join(root, 'candidate.tar.gz');
  const files = new Map<string, Uint8Array>([
    ['bin/kite', bytes('#!/bin/sh\necho Kite\n')],
    ['bin/kite-tui', bytes('#!/bin/sh\necho Kite TUI\n')],
    ['docs/MAINTAINER_CHECKLIST.md', bytes('# Checklist\n')],
    ['docs/KNOWN_LIMITATIONS.md', bytes('# Limitations\n')],
    ['docs/RELEASE_NOTES.md', bytes('# Notes\n')],
  ]);
  const manifest = ossCandidateManifestSchema.parse({
    schema: 'KiteCodeOssCandidateManifest',
    version: 1,
    productVersion: version,
    commitSha: 'a'.repeat(40),
    sourceDate: '2026-08-04T00:00:00.000Z',
    sourceDirty: false,
    bunVersion: '1.3.14',
    target: { ...target, compileMode: 'native' },
    integrity: 'sha256-only-unsigned',
    defaultCapabilities: {
      autoCompaction: 'off',
      effectfulCapabilities: 'off',
      remoteTelemetry: 'off',
    },
    files: [...files]
      .map(([path, value]) => ({ path, size: value.byteLength, sha256: digest(value) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  await writeOssCandidateArchive({ archivePath, manifest, files });
  return { root, archivePath, manifest, files };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
