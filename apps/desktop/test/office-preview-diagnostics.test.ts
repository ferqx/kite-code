import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { officePreviewDiagnosticEntry } from './office-preview-diagnostics.fixture';

test('fixture diagnostics preserve IPC behavior and never retain payload or arbitrary errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-office-diagnostics-test-'));
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    const records: string[] = [];
    let entryLoaded = false;
    const ipcMain = {
      handle(channel: string, listener: (...args: any[]) => any) {
        handlers.set(channel, listener);
      },
    };
    runInNewContext(readFileSync(officePreviewDiagnosticEntry(root, root), 'utf8'), {
      require(name: string) {
        if (name === 'electron') return { app: { on() {} }, ipcMain };
        if (name === 'node:fs')
          return {
            appendFileSync(_path: string, value: string) {
              records.push(value);
            },
          };
        if (name === './main.cjs') {
          entryLoaded = true;
          return {};
        }
        throw Error('unexpected_import');
      },
    });
    expect(entryLoaded).toBe(true);
    const reply = { ok: false, code: 'preview_replaced', privateData: 'SECRET' };
    ipcMain.handle('kite:native:request', async (_event, request) => {
      if (request.fail) throw Error('SECRET /private/user/file');
      return reply;
    });
    const handler = handlers.get('kite:native:request')!;
    expect(await handler({}, { method: 'outputs.preview.open', secret: 'SECRET' })).toBe(reply);
    expect(records.join('')).toContain('preview_replaced');
    const before = records.length;
    await handler({}, { method: 'outputs.info', secret: 'SECRET' });
    expect(records.length).toBe(before);
    await expect(handler({}, { method: 'outputs.preview.open', fail: true })).rejects.toThrow(
      'SECRET',
    );
    expect(records.join('')).toContain('redacted_error');
    expect(records.join('')).not.toContain('SECRET');
    expect(records.join('')).not.toContain('/private/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
