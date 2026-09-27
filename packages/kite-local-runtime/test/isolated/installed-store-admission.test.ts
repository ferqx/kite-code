import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { LegacyKiteProcessIdentity } from '../../src/service/legacy-store-processes';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('installed admission ignores unrelated installed entrypoints but revalidates selection', async () => {
  if (process.platform !== 'darwin') return;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-installed-admission-')));
  roots.push(root);
  const installRoot = join(root, 'install');
  const home = join(root, 'home');
  const runtimeRoot = join(root, 'runtime');
  const extraBin = join(root, 'extra-bin');
  for (const path of [installRoot, home, runtimeRoot, extraBin])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(extraBin, 'kite'), 'another launcher');
  const serviceBytes = Buffer.from('fixture service');
  const serviceHash = createHash('sha256').update(serviceBytes).digest('hex');
  const manifestBytes = Buffer.from(
    JSON.stringify({
      storeMaintenanceContract: 'managed-release-selection-v1',
      files: [{ path: 'bin/kite-service', sha256: `sha256:${serviceHash}` }],
      releaseSlots: {
        service: { entrypoint: 'bin/kite-service', identity: `sha256:${serviceHash}` },
      },
    }),
  );
  const id = createHash('sha256').update(manifestBytes).digest('hex').slice(0, 24);
  const candidateRoot = join(installRoot, 'releases', id);
  const executable = join(candidateRoot, 'bin/kite-service');
  mkdirSync(dirname(executable), { recursive: true });
  const privateFile = (path: string, contents: string | Buffer) => {
    writeFileSync(path, contents);
    chmodSync(path, 0o600);
  };
  privateFile(executable, serviceBytes);
  privateFile(join(candidateRoot, 'manifest.json'), manifestBytes);
  privateFile(join(candidateRoot, '.candidate-id'), `${id}\n`);
  privateFile(join(installRoot, 'active'), `${id}\n`);
  privateFile(
    join(installRoot, '.kite-code-managed.json'),
    JSON.stringify({
      schema: 'KiteCodeManagedInstall',
      version: 2,
      canonicalRoot: installRoot,
      currentCandidateId: id,
      activePointer: 'active',
    }),
  );

  const lineage: readonly LegacyKiteProcessIdentity[] = [{ pid: 123, startIdentity: 'fixture' }];
  const observations: Array<Record<string, unknown>> = [];
  mock.module(resolve(import.meta.dir, '../../src/service/legacy-store-processes.ts'), () => ({
    readKiteInstalledStdioLineage: () => lineage,
    observeLegacyKiteStoreProcesses: (input: Record<string, unknown>) => {
      observations.push(input);
      return { status: 'complete', matches: [] };
    },
  }));
  mock.module(
    resolve(import.meta.dir, '../../src/service/managed-release-selection-lock.ts'),
    () => ({
      acquireManagedReleaseSelectionLock: () => ({ revalidate() {}, release() {} }),
      declareManagedStoreMaintenanceContract: () => {},
    }),
  );
  const { acquireInstalledKiteStoreAdmission } = await import(
    '../../src/service/installed-store-admission'
  );
  const original = {
    execPath: process.execPath,
    argv: process.argv,
    path: process.env.PATH,
    standalone: process.env.KITE_STANDALONE_EXECUTABLE,
    release: process.env.KITE_CODE_RELEASE_ROOT,
    candidate: process.env.KITE_CODE_CANDIDATE_ID,
    build: process.env.KITE_APP_SERVER_BUILD_ID,
    config: process.env.KITE_CODE_CONFIG_HOME,
    home: process.env.KITE_CODE_HOME,
  };
  try {
    process.execPath = executable;
    process.argv = [executable, executable, 'app-server', 'run-stdio'];
    process.env.PATH = `${extraBin}:/usr/bin:/bin`;
    process.env.KITE_STANDALONE_EXECUTABLE = '1';
    process.env.KITE_CODE_RELEASE_ROOT = candidateRoot;
    process.env.KITE_CODE_CANDIDATE_ID = id;
    process.env.KITE_APP_SERVER_BUILD_ID = id;
    process.env.KITE_CODE_CONFIG_HOME = home;
    process.env.KITE_CODE_HOME = runtimeRoot;
    expect(process.execPath).toBe(executable);
    expect(process.argv).toEqual([executable, executable, 'app-server', 'run-stdio']);
    const result = acquireInstalledKiteStoreAdmission({ canonicalKiteHome: home, runtimeRoot });
    expect(result).toMatchObject({ admitted: true });
    if (!result.admitted) return;
    try {
      expect(observations).toEqual([
        { exclude: lineage, canonicalKiteHome: home, managedInstallPrefixes: [installRoot] },
      ]);
      privateFile(join(installRoot, 'active'), `${'0'.repeat(24)}\n`);
      expect(() => result.lease.revalidate()).toThrow('Active candidate changed.');
    } finally {
      result.lease.release();
    }
  } finally {
    process.execPath = original.execPath;
    process.argv = original.argv;
    for (const [key, value] of Object.entries({
      PATH: original.path,
      KITE_STANDALONE_EXECUTABLE: original.standalone,
      KITE_CODE_RELEASE_ROOT: original.release,
      KITE_CODE_CANDIDATE_ID: original.candidate,
      KITE_APP_SERVER_BUILD_ID: original.build,
      KITE_CODE_CONFIG_HOME: original.config,
      KITE_CODE_HOME: original.home,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
