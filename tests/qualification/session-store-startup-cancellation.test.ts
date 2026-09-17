import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServiceStartupDiagnostic } from '@kite-ai/kite-local-runtime/startup-diagnostic';
import {
  assertKiteSessionStoreSchema,
  initializeKiteHomeStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../packages/runtime-storage-sqlite/src/kite-session-maintenance';
import { inspectKiteSessionPublication } from '../../packages/runtime-storage-sqlite/src/kite-session-store-publication';
import { inspectKiteSessionStoreSources } from '../../packages/runtime-storage-sqlite/src/kite-session-store-sources';

const childEntry = join(import.meta.dir, 'fixtures/session-store-startup-cancellation-child.ts');
const crashedPublisher = join(import.meta.dir, 'fixtures/session-store-publication-child.ts');

function fixture(historical: boolean) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-startup-cancel-')));
  const runtimeRoot = join(home, '.kite-code');
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const canonicalPath = join(runtimeRoot, 'kite-session.sqlite');
  const oldPath = join(runtimeRoot, 'kite.sqlite');
  using canonical = new Database(canonicalPath, { strict: true });
  initializeKiteSessionStoreIfNeeded(canonical);
  canonical.run('PRAGMA journal_mode=DELETE');
  chmodSync(canonicalPath, 0o600);
  if (historical) {
    using old = new Database(oldPath, { strict: true });
    initializeKiteHomeStoreSchema(old);
    old.run('PRAGMA journal_mode=DELETE');
    chmodSync(oldPath, 0o600);
  }
  return {
    home,
    canonicalPath,
    oldPath,
    dispose() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function waitFor(path: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Service exited before ${path}`);
    await Bun.sleep(10);
  }
  expect(existsSync(path)).toBe(true);
}

async function exited(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const outcome = await Promise.race([
    child.exited,
    Bun.sleep(10_000).then(() => {
      throw new Error('Service did not exit within 10 seconds');
    }),
  ]);
  return outcome;
}

function spawnService(home: string, scenario: string) {
  return Bun.spawn([process.execPath, childEntry], {
    cwd: home,
    env: { ...process.env, KITE_QUALIFICATION_HOME: home, KITE_QUALIFICATION_SCENARIO: scenario },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe.skipIf(process.platform === 'win32')('Service startup cancellation', () => {
  test('signal before the prepublication release cancels without changing original Store bytes', async () => {
    const data = fixture(true);
    const original = [readFileSync(data.canonicalPath), readFileSync(data.oldPath)];
    const child = spawnService(data.home, 'gate-cancel');
    try {
      await waitFor(join(data.home, 'gate-ready'), child);
      expect(() => acquireKiteSessionStoreMaintenance(data.canonicalPath, 'exclusive')).toThrow(
        expect.objectContaining({ code: 'store_busy' }),
      );
      child.kill('SIGTERM');
      writeFileSync(join(data.home, 'gate-release'), 'release', { mode: 0o600 });
      expect(await exited(child)).toBe(1);
      expect(parseServiceStartupDiagnostic(await new Response(child.stderr).text())).toEqual({
        code: 'store_preparation_cancelled',
        actualSchema: null,
        expectedSchema: null,
        stage: 'preparing',
      });
      expect([readFileSync(data.canonicalPath), readFileSync(data.oldPath)]).toEqual(original);
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
      acquireKiteSessionStoreMaintenance(data.canonicalPath, 'exclusive').release();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      data.dispose();
    }
  }, 20_000);

  test('signal at synchronous publication settles before Service exits', async () => {
    const data = fixture(true);
    const child = spawnService(data.home, 'publishing-signal');
    try {
      expect(await exited(child)).toBe(0);
      expect(existsSync(join(data.home, 'publishing'))).toBe(true);
      expect(
        parseServiceStartupDiagnostic(await new Response(child.stderr).text()),
      ).toBeUndefined();
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
      expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([]);
      using published = new Database(data.canonicalPath, { readonly: true });
      assertKiteSessionStoreSchema(published);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      data.dispose();
    }
  }, 20_000);

  test('signal during an already committed publication resumes and settles the intent', async () => {
    const data = fixture(true);
    const migrationDirectory = join(
      data.home,
      '.kite-code',
      'session-store-recovery',
      'migration-0123456789abcdef01234567',
    );
    const candidateDirectory = join(migrationDirectory, 'converted-0');
    mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(join(data.home, '.kite-code', 'session-store-recovery'), 0o700);
    chmodSync(migrationDirectory, 0o700);
    chmodSync(candidateDirectory, 0o700);
    const candidatePath = join(candidateDirectory, 'kite-session.sqlite');
    const candidate = new Database(candidatePath, { strict: true });
    initializeKiteSessionStoreIfNeeded(candidate);
    candidate.run('PRAGMA journal_mode=DELETE');
    chmodSync(candidatePath, 0o600);
    candidate.close(false);
    const publisher = Bun.spawn(
      [process.execPath, crashedPublisher, join(data.home, '.kite-code')],
      { cwd: data.home, stdout: 'ignore', stderr: 'pipe' },
    );
    try {
      expect(await exited(publisher)).toBe(75);
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('pending');
      const child = spawnService(data.home, 'pending-publishing-signal');
      try {
        expect(await exited(child)).toBe(0);
        expect(existsSync(join(data.home, 'publishing'))).toBe(true);
        expect(
          parseServiceStartupDiagnostic(await new Response(child.stderr).text()),
        ).toBeUndefined();
        expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
        expect(inspectKiteSessionStoreSources(data.canonicalPath)).toEqual([]);
        using published = new Database(data.canonicalPath, { readonly: true });
        assertKiteSessionStoreSchema(published);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await child.exited;
      }
    } finally {
      if (publisher.exitCode === null) publisher.kill('SIGKILL');
      await publisher.exited;
      data.dispose();
    }
  }, 20_000);

  test('signal after ready on a current Store exits without hanging', async () => {
    const data = fixture(false);
    const child = spawnService(data.home, 'current-ready');
    try {
      await waitFor(join(data.home, 'ready'), child);
      child.kill('SIGTERM');
      expect(await exited(child)).toBe(0);
      expect(inspectKiteSessionPublication(data.canonicalPath).status).toBe('none');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      data.dispose();
    }
  }, 20_000);
});
