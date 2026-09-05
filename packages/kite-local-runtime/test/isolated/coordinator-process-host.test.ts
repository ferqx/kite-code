import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoordinatorProcessExecutable,
  createCoordinatorExecutableResolver,
  createCoordinatorProcessHost,
  createCoordinatorProcessPort,
  readCoordinatorProcessStartIdentity,
  resolveCoordinatorProcessSpawnCommand,
} from '@kite-ai/kite-local-runtime/coordinator';

const roots: string[] = [];
const children: number[] = [];

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The fixture may already have exited.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const executable: CoordinatorProcessExecutable = {
  path: '/repo/coordinator.ts',
  mode: 'source',
  buildId: 'build-host-1',
};

const readyScript = `#!/usr/bin/env bun
import { closeSync, writeSync } from 'node:fs';
const fd = Number(process.env.KITE_COORDINATOR_READY_FD);
writeSync(fd, Buffer.from(JSON.stringify({
  schema: 'kite.local-coordinator-ready.v1',
  instanceId: 'fixture-instance',
  pid: process.pid,
  startedAt: '2026-08-29T00:00:00.000Z',
  processStartIdentity: 'fixture-start',
  buildId: 'build-host-1',
  protocolVersion: 1,
  protocolRevision: 'kite-local-coordinator-protocol-v3',
  clientContractRevision: 'kite-local-coordinator-client-v3'
}) + '\\n'));
closeSync(fd);
setInterval(() => undefined, 1000);
`;

describe('Coordinator process executable and host', () => {
  test('resolves source and installed paths exactly without PATH fallback', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-resolver-')));
    roots.push(root);
    const sourcePath = join(root, 'coordinator.ts');
    const installedPath = join(root, 'coordinator-bin');
    writeFileSync(sourcePath, '// source');
    writeFileSync(installedPath, 'binary');
    const resolver = createCoordinatorExecutableResolver({
      source: sourcePath,
      installed: installedPath,
      sourceBuildId: 'source-build',
      installedBuildId: 'installed-build',
    });
    await expect(resolver.resolve('source')).resolves.toEqual({
      path: sourcePath,
      mode: 'source',
      buildId: 'source-build',
    });
    await expect(resolver.resolve('installed')).resolves.toEqual({
      path: installedPath,
      mode: 'installed',
      buildId: 'installed-build',
    });
    expect(
      resolveCoordinatorProcessSpawnCommand(executable, ['coordinator', 'run'], 'win32', '/bun'),
    ).toEqual({ command: '/bun', args: ['/repo/coordinator.ts', 'coordinator', 'run'] });
    expect(
      resolveCoordinatorProcessSpawnCommand(executable, ['coordinator', 'run'], 'darwin', '/bun'),
    ).toEqual({ command: '/bun', args: ['/repo/coordinator.ts', 'coordinator', 'run'] });
    expect(
      resolveCoordinatorProcessSpawnCommand(
        { path: '/opt/kite/coordinator', mode: 'installed' },
        ['coordinator', 'run'],
        'win32',
        '/bun',
      ),
    ).toEqual({ command: '/opt/kite/coordinator', args: ['coordinator', 'run'] });
  });

  test('rejects relative, missing, directory, and symlink executable paths', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-resolver-invalid-')));
    roots.push(root);
    const file = join(root, 'coordinator');
    const link = join(root, 'coordinator-link');
    writeFileSync(file, 'binary');
    symlinkSync(file, link);
    expect(() =>
      createCoordinatorExecutableResolver({ source: 'coordinator.ts', installed: file }),
    ).toThrow();
    expect(() =>
      createCoordinatorExecutableResolver({
        source: join(root, 'missing'),
        installed: file,
      }).resolve('source'),
    ).toThrow();
    expect(() =>
      createCoordinatorExecutableResolver({ source: root, installed: file }).resolve('source'),
    ).toThrow();
    expect(() =>
      createCoordinatorExecutableResolver({ source: link, installed: file }).resolve('source'),
    ).toThrow();
    await expect(
      createCoordinatorExecutableResolver({
        source: join(root, 'missing'),
        installed: file,
      }).resolve('installed'),
    ).resolves.toMatchObject({ path: file, mode: 'installed' });
  });

  test.skipIf(process.platform === 'win32')(
    'reads one server-owned readiness record from a real child',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-process-host-')));
      roots.push(root);
      const path = join(root, 'coordinator-fixture');
      writeFileSync(path, readyScript, { mode: 0o700 });
      chmodSync(path, 0o700);
      const child = await createCoordinatorProcessHost().spawn({
        executable: { path, mode: 'source', buildId: 'build-host-1' },
        args: [],
        cwd: root,
        env: {},
        detached: true,
        stdout: 'ignore',
      });
      children.push(child.pid);
      await expect(child.waitForReady()).resolves.toMatchObject({
        instanceId: 'fixture-instance',
        pid: child.pid,
        buildId: 'build-host-1',
      });
      await child.readiness.release();
      expect(
        await createCoordinatorProcessPort().inspect({
          pid: child.pid,
          processStartIdentity: 'wrong',
        }),
      ).toBe('uncertain');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a duplicate readiness frame after the valid record',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-ready-duplicate-')));
      roots.push(root);
      const path = join(root, 'coordinator-fixture');
      writeFileSync(
        path,
        readyScript.replace('closeSync(fd);', "writeSync(fd, '{}\\n');\ncloseSync(fd);"),
        { mode: 0o700 },
      );
      const child = await createCoordinatorProcessHost().spawn({
        executable: { path, mode: 'source', buildId: 'build-host-1' },
        args: [],
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        detached: true,
        stdout: 'ignore',
      });
      children.push(child.pid);
      await expect(child.waitForReady()).rejects.toMatchObject({ code: 'ready_failed' });
      await child.readiness.release();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'probes an exact native process start identity without killing it',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-process-probe-')));
      roots.push(root);
      const path = join(root, 'coordinator-fixture');
      writeFileSync(path, readyScript, { mode: 0o700 });
      const child = await createCoordinatorProcessHost().spawn({
        executable: { path, mode: 'source', buildId: 'build-host-1' },
        args: [],
        cwd: root,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        detached: true,
        stdout: 'ignore',
      });
      children.push(child.pid);
      await child.waitForReady();
      await child.readiness.release();
      const start = await readCoordinatorProcessStartIdentity(child.pid);
      expect(start).toBeString();
      if (process.platform === 'darwin') {
        const localizedProbe = Bun.spawn(
          [
            process.execPath,
            '-e',
            `import { readCoordinatorProcessStartIdentity } from '@kite-ai/kite-local-runtime/coordinator'; process.stdout.write(JSON.stringify(await readCoordinatorProcessStartIdentity(${child.pid})));`,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, LC_ALL: 'zh_CN.UTF-8', LANG: 'zh_CN.UTF-8' },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const localizedOutput = await new Response(localizedProbe.stdout).text();
        expect(await localizedProbe.exited).toBe(0);
        expect(JSON.parse(localizedOutput)).toBe(start);
      }
      expect(
        await createCoordinatorProcessPort().inspect({
          pid: child.pid,
          processStartIdentity: start!,
        }),
      ).toBe('alive');
    },
  );

  test('keeps a Windows named-pipe runner injectable without disabling native startup', async () => {
    let runnerCalls = 0;
    const host = createCoordinatorProcessHost({
      platform: 'win32',
      runtimeExecutable: '/bun',
      executableVerifier: ({ path }) => path,
      windowsRunner: {
        async spawn() {
          runnerCalls += 1;
          return {
            pid: 9001,
            readiness: { async release() {} },
            async waitForReady() {
              return {
                schema: 'kite.local-coordinator-ready.v1' as const,
                instanceId: 'windows-fixture',
                pid: 9001,
                startedAt: '2026-08-29T00:00:00.000Z',
                processStartIdentity: 'windows-fixture-start',
                buildId: 'build-host-1',
                protocolVersion: 1 as const,
                protocolRevision: 'kite-local-coordinator-protocol-v3',
                clientContractRevision: 'kite-local-coordinator-client-v3',
              };
            },
          };
        },
      },
    });
    const child = await host.spawn({
      executable,
      args: [],
      cwd: '/repo',
      env: {},
      detached: true,
      stdout: 'ignore',
    });
    expect(runnerCalls).toBe(1);
    await expect(child.waitForReady()).resolves.toMatchObject({ pid: 9001 });
  });
});
