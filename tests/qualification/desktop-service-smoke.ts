import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runElectronPairedServiceSmoke } from '../../apps/kite-desktop/test/host-paired-service';
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
  const result = await runElectronPairedServiceSmoke({
    home,
    workspace: join(home, 'workspace'),
  });
  model.assertComplete();
  assert.equal(model.getRequests()[0]?.body.reasoning_effort, 'max');
  assert.equal(Object.hasOwn(model.getRequests()[1]?.body ?? {}, 'reasoning_effort'), false);
  console.log(
    `Desktop Electron transport: per-Run reasoning effort, renderer reattachment during streaming, durable history, active EOF cleanup and successor read passed (${Math.round(result.startupMilliseconds)}ms to initial directory). No external Provider was used.`,
  );
} finally {
  model.stop();
  rmSync(home, { recursive: true, force: true });
}
