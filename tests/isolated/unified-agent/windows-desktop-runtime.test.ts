import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '#kite-test';
import {
  buildDesktopRuntime,
  buildDesktopWorkspace,
  desktopModuleMap,
  writeDesktopImports,
} from '../../../scripts/release/desktop-runtime';

async function verifyPortableImports(executable: string) {
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
        '--target=node',
        '--packages=bundle',
        '--splitting',
        '--external=@kite-ai/agent',
        '--root=.',
        `--outdir=${service}`,
      ],
      modules,
    );
    writeDesktopImports(code, [service], modules);
    const result = spawnSync(executable, ['--no-global-search-paths', entry], {
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
}

const node = process.execPath;
test('the desktop compiler resolves imports and shared requires under Node', async () => {
  await verifyPortableImports(node);
});

test.skipIf(!node || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'the Node desktop DOM parser loads its CSS data with read access limited to the artifact',
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-desktop-css-')));
    try {
      await buildDesktopRuntime(
        resolve(import.meta.dirname, '../../..'),
        root,
        [],
        desktopModuleMap([]),
        'node',
      );
      const probe = join(root, 'code/probe.cjs');
      writeFileSync(
        probe,
        `const { JSDOM } = require('#kite-runtime/jsdom');
const { window } = new JSDOM('<p style="color: red">Fixture</p>');
console.log(window.getComputedStyle(window.document.querySelector('p')).color);
window.close();`,
      );
      const result = spawnSync(
        node!,
        ['--permission', `--allow-fs-read=${root}`, '--no-global-search-paths', probe],
        {
          cwd: root,
          env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect({
        status: result.status,
        stderr: result.stderr,
        stdout: result.stdout.trim(),
      }).toEqual({
        status: 0,
        stderr: '',
        stdout: 'rgb(255, 0, 0)',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
