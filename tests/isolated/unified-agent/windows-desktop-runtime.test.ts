import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildDesktopWorkspace,
  writeDesktopImports,
} from '../../../scripts/release/desktop-runtime';

test('the desktop compiler resolves imports and shared requires within the portable artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-desktop-link-'));
  const source = join(root, 'source');
  const code = join(root, 'code');
  const service = join(code, '@kite-ai/service');
  const agent = join(code, '@kite-ai/agent/artifact-access.js');
  const entry = join(service, 'nested/main.js');
  const modules = new Map([
    ['@kite-ai/agent/artifact-access', './@kite-ai/agent/artifact-access.js'],
  ]);
  try {
    mkdirSync(dirname(agent), { recursive: true });
    mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(agent, 'export const proof = {};\n');
    writeFileSync(
      join(source, 'shared.ts'),
      'export const required = require("@kite-ai/agent/artifact-access");\n',
    );
    writeFileSync(
      join(source, 'nested/main.ts'),
      `import { required } from "../shared";
const imported = await import("@kite-ai/agent/artifact-access");
console.log(required.proof === imported.proof);`,
    );
    await buildDesktopWorkspace(
      source,
      [
        './nested/main.ts',
        './shared.ts',
        '--target=bun',
        '--packages=bundle',
        '--splitting',
        '--external=@kite-ai/agent',
        '--root=.',
        `--outdir=${service}`,
      ],
      modules,
    );
    writeDesktopImports(code, [service], modules);
    const result = spawnSync(process.execPath, ['--no-env-file', '--no-install', entry], {
      cwd: root,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 5000,
    });
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stderr: '',
      stdout: 'true',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
