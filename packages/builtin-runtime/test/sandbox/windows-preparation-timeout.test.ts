import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeWindowsRestrictedTokenPreparedTransport,
  prepareWindowsRestrictedTokenTransport,
} from '../../src/sandbox/execution/windows-preparation';

test('Windows prepared transport preserves explicit no timer and bounded timeout', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-windows-timeout-'));
  try {
    for (const [timeoutMs, expected] of [
      [null, null],
      [1234, 1234],
      [undefined, 600_000],
    ] as const) {
      const result = prepareWindowsRestrictedTokenTransport(
        { enabled: true, workspace: root },
        { workspace: root, command: 'printf complete', timeoutMs },
        root,
        {
          path: 'C:\\runner.exe',
          version: '0.8.3',
          digest: `sha256:${'a'.repeat(64)}`,
          minimumWindowsVersion: '10.0.19045',
          protocolVersion: 6,
          shellRuntimePath: 'C:\\shell',
          shellRuntime: 'busybox',
          shellRuntimeDigest: `sha256:${'b'.repeat(64)}`,
          coreutilsDigest: `sha256:${'c'.repeat(64)}`,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.prepared.request.timeoutMs).toBe(expected);
      const decoded = decodeWindowsRestrictedTokenPreparedTransport(
        JSON.stringify(result.prepared),
      );
      expect(decoded.request.timeoutMs).toBe(expected);
      for (const invalid of [0, -1, 1.5, '1234']) {
        expect(() =>
          decodeWindowsRestrictedTokenPreparedTransport(
            JSON.stringify({
              ...result.prepared,
              request: { ...result.prepared.request, timeoutMs: invalid },
            }),
          ),
        ).toThrow();
      }
      const request = { ...result.prepared.request };
      Reflect.deleteProperty(request, 'timeoutMs');
      expect(() =>
        decodeWindowsRestrictedTokenPreparedTransport(
          JSON.stringify({ ...result.prepared, request }),
        ),
      ).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
