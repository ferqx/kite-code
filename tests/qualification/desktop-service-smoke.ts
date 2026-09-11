import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMockModelServer } from '../tui-system/harness/fixtures';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'kite-desktop-smoke-')));
const model = createMockModelServer();
model.setResponses([
  { message: { content_chunks: ['desktop smoke', ' complete'] }, chunk_delay: 120 },
  { message: { content: 'must not complete after EOF' }, delay: 15_000 },
]);
try {
  mkdirSync(join(home, '.kite-code'), { mode: 0o700 });
  mkdirSync(join(home, 'workspace'));
  writeFileSync(
    join(home, '.kite-code/kite-code.jsonc'),
    JSON.stringify({
      provider: {
        test: {
          type: 'openai-compatible',
          apiKey: 'local-fixture',
          baseURL: model.baseURL,
          model: 'mock-model',
          models: ['mock-model'],
        },
      },
      model: { default: { provider: 'test', name: 'mock-model' } },
      interactionMode: 'auto',
      sandbox: { enabled: false },
      features: {},
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  const child = Bun.spawn(
    [
      'cargo',
      'test',
      '--manifest-path',
      resolve('apps/kite-desktop/src-tauri/Cargo.toml'),
      '--test',
      'paired_service',
      '--',
      '--ignored',
      '--nocapture',
    ],
    {
      env: { ...process.env, KITE_DESKTOP_SMOKE_HOME: home },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const exit = await child.exited;
  if (exit !== 0) throw new Error(`Rust paired service smoke failed (${exit}).`);
  model.assertComplete();
  console.log(
    'Desktop Rust transport: renderer reattachment during streaming, durable history, active EOF cleanup and successor read passed. No external Provider was used.',
  );
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
