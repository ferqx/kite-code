import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { parse } from 'jsonc-parser';

test('TUI preferences and App Server config preserve each other across processes', async () => {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-config-multi-process-')),
  );
  const configPath = join(root, 'kite-code.jsonc');
  const preferenceChild = resolve(
    import.meta.dir,
    '../../../kite-cli/test/fixtures/write-preference-child.ts',
  );
  const providerChild = resolve(import.meta.dir, '../fixtures/write-provider-config-child.ts');
  try {
    const startAt = Date.now() + 250;
    const children = [
      Bun.spawn([process.execPath, preferenceChild, root, 'language', 'zh-CN', String(startAt)], {
        stderr: 'pipe',
      }),
      Bun.spawn([process.execPath, providerChild, configPath, String(startAt)], {
        stderr: 'pipe',
      }),
    ];
    await Promise.all(children.map(expectChildSuccess));
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(config.language).toBe('zh-CN');
    expect(config.provider).toMatchObject({
      'fixture-provider': {
        baseURL: 'https://provider.example/v1',
        models: ['fixture-model'],
        model: 'fixture-model',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function expectChildSuccess(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
}
