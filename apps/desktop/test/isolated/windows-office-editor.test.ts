import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyOfficeRuntimeAssets } from '@kite-ai/agent/documents';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { initializeDesktopBuildEnvironment } from '../../../../scripts/development/windows-desktop-environment';
import { buildWindowsAccess } from '../../scripts/build-windows-access';
import { historyFixture } from '../office-history.fixture';

test.skipIf(process.platform !== 'win32')(
  'actual Electron reads retained Office versions with immutable pins, live ACLs and no restoration',
  async () => {
    initializeDesktopBuildEnvironment();
    const root = join(tmpdir(), `kite-windows-office-${crypto.randomUUID()}`);
    privateDirectory(root);
    let passed = false;
    try {
      const native = join(root, 'native');
      privateDirectory(native);
      privateDirectory(join(root, 'data'));
      privateDirectory(join(root, 'data/office'));
      privateDirectory(join(root, 'data/facade'));
      const history = historyFixture(join(root, 'data/office/desktop-private/office-editor'));
      privateDirectory(join(root, 'data/facade/desktop-private/office-editor'));
      const addon = await buildWindowsAccess(native);
      const assets = await verifyOfficeRuntimeAssets();
      const helper = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
        target: 'bun',
        format: 'esm',
        packages: 'bundle',
        outdir: root,
        naming: 'profile-access.js',
      });
      if (!helper.success) throw new AggregateError(helper.logs, 'profile_helper_build_failed');
      const bunExecutable = realpathSync(process.execPath);
      const helperPath = join(root, 'profile-access.js');
      const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../windows-office-editor.fixture.ts')],
        target: 'node',
        format: 'esm',
        outdir: root,
        naming: 'fixture.mjs',
      });
      if (!built.success)
        throw new AggregateError(built.logs, 'windows_office_fixture_build_failed');
      const electron = createRequire(join(import.meta.dir, '../../package.json'))(
        'electron',
      ) as string;
      const result = spawnSync(
        electron,
        [
          join(root, 'fixture.mjs'),
          JSON.stringify({
            root,
            history,
            profileInputs: {
              bunExecutable,
              bunSha256: sha(bunExecutable),
              helperPath,
              helperSha256: sha(helperPath),
            },
            assetsRoot: assets.root,
            addon: { path: join(native, addon.relativePath), sha256: addon.sha256 },
          }),
        ],
        {
          env: { SystemRoot: process.env.SystemRoot, PATH: '', ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 90000,
        },
      );
      expect(result.status, `${result.stdout + result.stderr}\nRetained fixture: ${root}`).toBe(0);
      const receipt = JSON.parse(result.stdout.trim());
      expect(receipt.phase).toBe('WINDOWS_OFFICE_NATIVE_PASS');
      expect(receipt.readOnly).toBe(true);
      expect(receipt.revision).toBe(1);
      expect(receipt.checks).toHaveLength(12);
      expect(result.stderr).toBe('');
      passed = true;
    } finally {
      // Failure retains the exact synthetic fixture for investigation.
      if (passed) rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
