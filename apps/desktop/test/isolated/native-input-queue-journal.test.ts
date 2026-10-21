import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileAccess } from '@kite-ai/agent/profile-access';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

test('actual Node queue journal migrates the private database, survives cold loss, retains original text until ack and rejects forged data', async () => {
  const root = temporaryDirectory('kite-input-queue-journal-');
  try {
    const profile = { dataRoot: join(root, 'data'), profile: 'desktop' };
    const initialized = acquireProfileAccess(profile);
    privateDirectory(initialized.profilePath);
    initialized.lock.release();
    const helper = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../../electron/profile-access-helper.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'queue-profile-access.js',
    });
    expect(helper.success).toBe(true);
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../native-input-queue-node.fixture.ts')],
      target: 'node',
      format: 'esm',
      packages: 'bundle',
      outdir: root,
      naming: 'queue-journal-node.js',
    });
    expect(built.success).toBe(true);
    const executable = realpathSync(process.execPath),
      helperPath = join(root, 'queue-profile-access.js');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const child = Bun.spawn(
      [
        realpathSync(Bun.which('node')!),
        join(root, 'queue-journal-node.js'),
        JSON.stringify(profile),
        executable,
        hash(executable),
        helperPath,
        hash(helperPath),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code) throw Error(`queue_journal_node_failed:${code}:${err}`);
      expect(code).toBe(0);
      expect(out).toContain('input-queue-cold-journal-ok');
    } finally {
      clearTimeout(timer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
