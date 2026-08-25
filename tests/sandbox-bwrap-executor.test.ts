import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSandboxBackend } from '@kite/builtin-runtime/sandbox';
import { createSandboxExecutor } from './helpers/sandbox-executor';

const hasNativeBubblewrap = detectSandboxBackend() === 'bubblewrap';

describe('bubblewrap sandbox executor integration', () => {
  if (!hasNativeBubblewrap) {
    test('reports an unusable or absent bubblewrap backend as excluded', () => {
      expect(hasNativeBubblewrap).toBe(false);
    });
    return;
  }

  test('enforces canonical workspace scope and cleans the invocation runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openpx-bwrap-native-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    mkdirSync(workspace);
    await Bun.write(join(workspace, '.keep'), 'workspace');
    writeFileSync(outside, 'outside-secret');
    try {
      const writable = createSandboxExecutor({ enabled: true, workspace });
      const write = await writable({
        workspace,
        command: `printf allowed > allowed.txt; printf '\n%s' "$TMPDIR"`,
      });
      expect(write.ok).toBe(true);
      expect(existsSync(join(workspace, 'allowed.txt'))).toBe(true);
      const runtimeTmp = write.stdout.trim();
      expect(runtimeTmp).toContain('openpx-sandbox-runtime');
      expect(existsSync(runtimeTmp)).toBe(false);

      const readOnly = createSandboxExecutor({
        enabled: true,
        workspace,
        filesystemScope: 'read_only',
        unavailableFallback: 'fail',
      });
      const deniedWrite = await readOnly({
        workspace,
        command: 'printf denied > read-only-denied.txt',
      });
      expect(deniedWrite.ok).toBe(false);
      expect(existsSync(join(workspace, 'read-only-denied.txt'))).toBe(false);

      const deniedOutside = await writable({ workspace, command: `cat "${outside}"` });
      expect(deniedOutside.ok).toBe(false);
      expect(deniedOutside.stdout).not.toContain('outside-secret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
