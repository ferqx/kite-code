import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { packager } from '@electron/packager';

if (process.platform !== 'darwin') throw new Error('桌面打包当前仅验证 macOS。');
const root = resolve(import.meta.dir, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await readFile(resolve(root, 'service/desktop.json'));
const staging = await mkdtemp(resolve(tmpdir(), 'kite-electron-package-'));
try {
  // Stage only bundled code. Workspace dependencies and developer files must not ship.
  await Promise.all(
    ['dist', 'dist-electron'].map((name) =>
      cp(resolve(root, name), resolve(staging, name), {
        recursive: true,
        filter: (source) => !source.endsWith('.map'),
      }),
    ),
  );
  await writeFile(
    resolve(staging, 'package.json'),
    JSON.stringify({
      name: 'kite',
      version: manifest.version,
      main: 'dist-electron/main.cjs',
    }),
  );
  await mkdir(resolve(root, 'out'), { recursive: true });
  const paths = await packager({
    dir: staging,
    name: 'kite',
    executableName: 'kite',
    appBundleId: 'dev.kite-code.desktop',
    icon: resolve(root, 'assets/icon.icns'),
    appVersion: manifest.version,
    electronVersion: manifest.devDependencies.electron,
    platform: 'darwin',
    arch: process.arch as 'arm64' | 'x64',
    out: resolve(root, 'out'),
    overwrite: true,
    asar: true,
    prune: false,
    extraResource: [resolve(root, 'service')],
    darwinDarkModeSupport: true,
  });
  console.log(paths.join('\n'));
} finally {
  await rm(staging, { recursive: true, force: true });
}
