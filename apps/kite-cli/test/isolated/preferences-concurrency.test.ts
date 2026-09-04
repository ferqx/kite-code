import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { parse } from 'jsonc-parser';

test('independent TUI processes preserve concurrent preference fields', async () => {
  const root = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-preferences-concurrent-')),
  );
  const fixture = join(import.meta.dir, '..', 'fixtures', 'write-preference-child.ts');
  try {
    const startAt = Date.now() + 250;
    const children = [
      Bun.spawn([process.execPath, fixture, root, 'language', 'zh-CN', String(startAt)], {
        stderr: 'pipe',
      }),
      Bun.spawn([process.execPath, fixture, root, 'colorPreset', 'violet', String(startAt)], {
        stderr: 'pipe',
      }),
    ];
    await Promise.all(children.map(expectChildSuccess));
    expect(parse(readFileSync(join(root, 'kite-code.jsonc'), 'utf8'))).toMatchObject({
      language: 'zh-CN',
      colorPreset: 'violet',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function expectChildSuccess(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
}
