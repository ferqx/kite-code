import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Isolated synthetic fixture entry only; never imported by product code. */
export function officePreviewDiagnosticEntry(outdir: string, evidence: string) {
  const entry = join(outdir, 'office-preview-diagnostics.cjs');
  writeFileSync(
    entry,
    `
const { app, ipcMain } = require('electron');
const { appendFileSync } = require('node:fs');
const destination = ${JSON.stringify(join(evidence, 'preview-events.jsonl'))};
const started = Date.now();
let sequence = 0;
const record = (event) => {
  try { appendFileSync(destination, JSON.stringify({ elapsedMs: Date.now() - started, ...event }) + '\\n'); } catch {}
};
const safeCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(value) ? value : 'redacted_error';
const originalHandle = ipcMain.handle;
ipcMain.handle = function(channel, listener) {
  if (channel !== 'kite:native:request') return originalHandle.call(this, channel, listener);
  return originalHandle.call(this, channel, async function(event, request, ...rest) {
    if (!['outputs.preview.open', 'outputs.preview.close'].includes(request?.method))
      return listener.call(this, event, request, ...rest);
    const id = ++sequence;
    record({ type: 'request', id, method: request.method });
    try {
      const reply = await listener.call(this, event, request, ...rest);
      record({ type: 'reply', id, ok: reply?.ok === true, ...(reply?.ok === false ? { code: safeCode(reply.code) } : {}) });
      return reply;
    } catch (error) {
      record({ type: 'throw', id, code: safeCode(error?.code ?? error?.message) });
      throw error;
    }
  });
};
app.on('web-contents-created', (_event, contents) => {
  const id = contents.id;
  record({ type: 'contents-created', id });
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => record({ type: 'load-failed', id, code, isMainFrame }));
  contents.on('render-process-gone', (_event, details) => record({ type: 'renderer-gone', id, reason: safeCode(details.reason), exitCode: details.exitCode }));
  contents.on('destroyed', () => record({ type: 'contents-destroyed', id }));
});
require('./main.cjs');
`,
  );
  return entry;
}
