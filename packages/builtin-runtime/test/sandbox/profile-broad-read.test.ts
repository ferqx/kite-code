import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSandboxProfile } from '../../src/sandbox/profile';

function seatbeltSubpath(path: string): string {
  return `(subpath "${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`;
}

describe('macOS broad read policy', () => {
  test('admits home configuration reads without broadening external writes', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'seatbelt-broad-workspace-'));
    try {
      const canonicalWorkspace = realpathSync.native(workspace);
      const profile = generateSandboxProfile(workspace, { readScope: 'broad' });
      expect(profile).toContain('(allow file-read* file-read-metadata)');
      expect(profile).not.toContain(seatbeltSubpath(join(homedir(), '.gitconfig')));
      expect(profile).toContain(
        `(allow file-write* file-write-create file-write-unlink file-ioctl\n  ${seatbeltSubpath(canonicalWorkspace)})`,
      );
      expect(profile).not.toContain(
        '(allow file-write* file-write-create file-write-unlink file-ioctl)',
      );
      expect(profile).not.toContain(seatbeltSubpath('/'));
      expect(profile).toContain('(deny network*)');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('keeps host control inaccessible and runtime temp non-executable', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'seatbelt-broad-workspace-'));
    const runtime = mkdtempSync(join(tmpdir(), 'seatbelt-broad-runtime-'));
    const control = mkdtempSync(join(tmpdir(), 'seatbelt-broad-control-'));
    try {
      const profile = generateSandboxProfile(workspace, {
        readScope: 'broad',
        sandboxRuntimeDir: runtime,
        sandboxControlBase: control,
      });
      expect(profile).toContain(
        `(deny file-read* file-read-metadata file-map-executable file-write* file-write-create file-write-unlink file-ioctl\n  ${seatbeltSubpath(realpathSync.native(control))})`,
      );
      const executableSection = profile.slice(
        profile.indexOf('(allow file-map-executable'),
        profile.indexOf(';; Writes are limited'),
      );
      expect(executableSection).not.toContain(seatbeltSubpath(realpathSync.native(runtime)));
      expect(profile).not.toContain('(allow file-read* file-read-metadata file-map-executable)');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      rmSync(control, { recursive: true, force: true });
    }
  });

  test('keeps explicit-root reading as the default', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'seatbelt-restricted-workspace-'));
    try {
      const profile = generateSandboxProfile(workspace);
      expect(profile).toContain(';; Read only the Workspace');
      expect(profile).not.toContain('(allow file-read* file-read-metadata)');
      expect(profile).toContain(seatbeltSubpath(realpathSync.native(workspace)));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('does not turn a read-only invocation into a writable one', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'seatbelt-broad-readonly-'));
    try {
      const profile = generateSandboxProfile(workspace, {
        readScope: 'broad',
        filesystemScope: 'read_only',
      });
      expect(profile).toContain('(allow file-read* file-read-metadata)');
      expect(profile).not.toContain(';; Writes are limited');
      expect(profile).not.toContain(
        '(allow file-write* file-write-create file-write-unlink file-ioctl)',
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('approved IP networking still denies host Unix sockets in broad read mode', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'seatbelt-broad-network-'));
    try {
      const profile = generateSandboxProfile(workspace, {
        readScope: 'broad',
        network: 'allow_all',
      });
      expect(profile).toContain('(allow network*)');
      expect(profile).toContain('(deny network-bind (local unix-socket))');
      expect(profile).toContain('(deny network-outbound (remote unix-socket))');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
