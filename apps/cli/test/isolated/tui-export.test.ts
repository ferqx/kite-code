import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTuiExporter } from '../../host/tui-export';

test('trusted user configuration directory receives only 0600 loaded Markdown; wrong Store/aborted/failure write no success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-tui-export-'));
  try {
    const config = join(root, 'user');
    const writer = createTuiExporter(config, 'store');
    const snapshot = {
      storeId: 'store',
      sessionId: 'a',
      generation: 1,
      messages: [
        {
          id: 'm',
          seq: '1',
          role: 'assistant' as const,
          content: `${'x'.repeat(9 * 1024 * 1024)}FULL_TAIL`,
          reasoning: 'REASON_TAIL',
          complete: true,
        },
      ],
    };
    const result = await writer.write(snapshot, new AbortController().signal);
    expect(result.path.startsWith(`${config}/session-`)).toBe(true);
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    const text = await readFile(result.path, 'utf8');
    expect(text).toContain('FULL_TAIL');
    expect(text).toContain('> REASON_TAIL');
    expect(Buffer.byteLength(text)).toBeGreaterThan(8 * 1024 * 1024);
    await expect(
      writer.write({ ...snapshot, storeId: 'foreign' }, new AbortController().signal),
    ).rejects.toThrow('export_store_mismatch');
    const abort = new AbortController();
    abort.abort();
    await expect(writer.write(snapshot, abort.signal)).rejects.toThrow();
    await mkdir(join(root, 'block'));
    await expect(
      createTuiExporter(result.path, 'store').write(snapshot, new AbortController().signal),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
