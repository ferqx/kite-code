import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';

test('actual Node private file cold restore, two-process CAS, paginated retained drafts and damaged bytes fail closed', async () => {
  const root = mkdtempSync('/private/tmp/kite-private-node-');
  try {
    const profile = { dataRoot: join(root, 'data'), profile: 'desktop' };
    const initialized = acquireProfileAccess(profile);
    mkdirSync(initialized.profilePath, { mode: 0o700 });
    initialized.lock.release();
    const helper = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'profile-access.js',
    });
    expect(helper.success).toBe(true);
    const bunExecutable = realpathSync(process.execPath),
      helperPath = join(root, 'profile-access.js');
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../private-data-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'driver.js',
    });
    expect(built.success).toBe(true);
    const nativeArgs = [
      JSON.stringify(profile),
      bunExecutable,
      sha(bunExecutable),
      helperPath,
      sha(helperPath),
    ];
    async function denied(code: string) {
      const denied = Bun.spawn(
        [realpathSync(Bun.which('node')!), join(root, 'driver.js'), 'denied', ...nativeArgs, code],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const output = new Response(denied.stdout).text(),
        error = new Response(denied.stderr).text();
      const timer = setTimeout(() => denied.kill('SIGKILL'), 15000);
      try {
        expect(await denied.exited).toBe(0);
        expect(await output).toContain('private-lease-denied');
        expect(existsSync(join(initialized.profilePath, 'desktop-private/data.sqlite'))).toBe(
          false,
        );
        if (denied.exitCode) console.error(await error);
      } finally {
        clearTimeout(timer);
      }
    }
    const runtimeProfile = await import(
      resolve(import.meta.dir, '../../../../packages/agent/src/platform/profile.ts')
    );
    const maintenance = runtimeProfile.acquireProfileAccess(profile, 'exclusive');
    try {
      await denied('owner_busy');
    } finally {
      maintenance.lock.release();
    }
    writeFileSync(join(initialized.coordinationPath, 'restore-journal.json'), '{}', {
      mode: 0o600,
    });
    try {
      await denied('restore_reconciliation_required');
    } finally {
      unlinkSync(join(initialized.coordinationPath, 'restore-journal.json'));
    }
    const child = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'driver.js'),
        'parent',
        JSON.stringify(profile),
        bunExecutable,
        sha(bunExecutable),
        helperPath,
        sha(helperPath),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const out = new Response(child.stdout).text(),
      err = new Response(child.stderr).text();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const code = await child.exited;
      const stderr = await err;
      if (code !== 0) console.error(stderr);
      expect(code).toBe(0);
      expect(await out).toContain('private-node-qualified');
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
