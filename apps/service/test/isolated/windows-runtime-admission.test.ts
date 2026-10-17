import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finiteNativeFixture } from '../../../../tests/fixtures/unified-agent/native-artifact-fixture';
import { releaseScratch } from '../../../../tests/fixtures/unified-agent/release-filesystem';
import {
  retainWindowsNativeRuntimeFiles,
  verifyNativeRuntimeBundle,
} from '../../src/native-runtime-assets';
import {
  retainWindowsTerminalRuntimeFiles,
  verifyTerminalRuntimeBundle,
} from '../../src/runtime-assets';
import {
  borrowWindowsPairedArtifact,
  retainWindowsPairedArtifact,
} from '../../src/windows-paired-artifact';

const windows = process.platform === 'win32';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test.skipIf(!windows)(
  'same-process admission rejects copied, mismatched and closed owners and keeps every borrower protected',
  () => {
    const parent = releaseScratch(join(tmpdir(), 'kite-admission-'));
    try {
      const root = join(finiteNativeFixture(parent), 'terminal');
      const bytes = readFileSync(join(root, 'terminal-manifest.json'));
      const manifest = JSON.parse(bytes.toString());
      const proof = { kind: 'terminal.candidate' as const, root, manifestSha256: hash(bytes) };
      const actual = {
        entrypoint: join(root, manifest.entries.daemon),
        executable: join(root, manifest.entries.runtime),
        buildId: `terminal-${proof.manifestSha256}`,
      };
      const access = retainWindowsPairedArtifact(proof, actual);
      try {
        expect(() => borrowWindowsPairedArtifact({ ...access }, proof, actual)).toThrow(
          'admission_invalid',
        );
        expect(() =>
          borrowWindowsPairedArtifact(access, { ...proof, manifestSha256: '0'.repeat(64) }, actual),
        ).toThrow('admission_invalid');
        expect(() =>
          borrowWindowsPairedArtifact(access, proof, {
            ...actual,
            entrypoint: join(root, manifest.entries.service),
          }),
        ).toThrow('admission_invalid');
        const first = borrowWindowsPairedArtifact(access, proof, actual),
          second = borrowWindowsPairedArtifact(access, proof, actual);
        expect(first.roots).toEqual([root]);
        expect(() => access.release()).toThrow('paired_artifact_in_use');
        first.release();
        first.release();
        expect(() => access.release()).toThrow('paired_artifact_in_use');
        expect(() => writeFileSync(actual.entrypoint, 'changed')).toThrow();
        second.release();
        const extra = join(root, 'node_modules', 'injected-after-admission.js');
        writeFileSync(extra, 'unexpected inventory');
        let unexpected: ReturnType<typeof borrowWindowsPairedArtifact> | undefined;
        try {
          expect(() => {
            unexpected = borrowWindowsPairedArtifact(access, proof, actual);
          }).toThrow();
        } finally {
          unexpected?.release();
          rmSync(extra);
        }
      } finally {
        access.release();
      }
      expect(() => borrowWindowsPairedArtifact(access, proof, actual)).toThrow('admission_invalid');
      writeFileSync(actual.entrypoint, 'changed after every original owner closed');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

test.skipIf(!windows)(
  'borrowed full verification rejects forged or wrong-root pins and still scans exact inventory and file bytes',
  () => {
    const parent = releaseScratch(join(tmpdir(), 'kite-pinned-content-'));
    try {
      const root = finiteNativeFixture(parent),
        terminal = join(root, 'terminal');
      const another = finiteNativeFixture(parent, 'another');
      const outer = retainWindowsNativeRuntimeFiles(root),
        inner = retainWindowsTerminalRuntimeFiles(terminal);
      try {
        expect(
          verifyNativeRuntimeBundle(root, undefined, { outer, terminal: inner }).terminal.digest,
        ).toBe(verifyTerminalRuntimeBundle(terminal, undefined, inner).digest);
        expect(() => verifyTerminalRuntimeBundle(terminal, undefined, { ...inner })).toThrow();
        expect(() =>
          verifyTerminalRuntimeBundle(join(another, 'terminal'), undefined, inner),
        ).toThrow();
        expect(() =>
          verifyNativeRuntimeBundle(root, undefined, { outer: { ...outer }, terminal: inner }),
        ).toThrow();
        const extra = join(terminal, 'node_modules', 'injected.js');
        writeFileSync(extra, 'unexpected inventory');
        expect(() => verifyTerminalRuntimeBundle(terminal, undefined, inner)).toThrow();
        rmSync(extra);
      } finally {
        inner.release();
        outer.release();
      }
      expect(() => verifyTerminalRuntimeBundle(terminal, undefined, inner)).toThrow();
      const manifest = JSON.parse(readFileSync(join(terminal, 'terminal-manifest.json'), 'utf8'));
      const entry = join(terminal, manifest.entries.service),
        original = readFileSync(entry);
      original[0] = original[0]! ^ 1;
      writeFileSync(entry, original);
      const corrupted = retainWindowsTerminalRuntimeFiles(terminal);
      try {
        expect(() => verifyTerminalRuntimeBundle(terminal, undefined, corrupted)).toThrow(
          'identity_mismatch',
        );
      } finally {
        corrupted.release();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
