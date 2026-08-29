import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorWorkerIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import {
  createNeutralWorkspaceWorkerEnvironmentResolver,
  createWorkspaceWorkerProcessExecutableResolver,
  createWorkspaceWorkerProcessHost,
  createWorkspaceWorkerProcessProbe,
  decodeWorkspaceWorkerReadySignal,
  resolveWorkspaceWorkerProcessSpawnCommand,
  verifyWorkspaceWorkerProcessExecutable,
  WORKSPACE_WORKER_STORE_PROFILE_,
  type WorkspaceWorkerControlLink,
  type WorkspaceWorkerProcessChild,
  type WorkspaceWorkerProcessSpawnInput,
  type WorkspaceWorkerReadySignal,
} from '../../src/workspace-worker/process-host';

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/workspace/host-test',
  projectId: 'project-host-test',
  workspaceDigest: `sha256:${'a'.repeat(64)}`,
};

function identity(): CoordinatorWorkerIdentity {
  return {
    role: 'worker',
    workerScopeId: 'scope-host',
    instanceId: 'instance-host',
    buildId: 'build-host',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function readySignal(): WorkspaceWorkerReadySignal {
  return {
    schema: 'kite.workspace-worker-ready.v1',
    identity: identity(),
    workspace,
    pid: 4242,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity: 'host-start-1',
    storeProfile: WORKSPACE_WORKER_STORE_PROFILE_,
    layoutGeneration: 'layout-1',
    endpoint: {
      origin: 'http://127.0.0.1:43142',
      websocketUrl: 'ws://127.0.0.1:43142/rpc',
    },
    controlOrigin: 'http://127.0.0.1:43144',
  };
}

function fakeControl(): WorkspaceWorkerControlLink {
  return {
    async describeIdentity() {
      return {
        workerScopeId: 'scope-host',
        workerInstanceId: 'instance-host',
        buildId: 'build-host',
        workspace,
      };
    },
    async mintConnectionCapability() {
      return { outcome: 'unavailable' as const };
    },
    async requestIdleStop() {
      return 'unavailable' as const;
    },
  };
}

function fakeChild(): WorkspaceWorkerProcessChild {
  return {
    pid: 4242,
    readiness: { async release() {} },
    control: fakeControl(),
    async waitForReady() {
      return readySignal();
    },
  };
}

describe('Workspace Worker process host', () => {
  test('decodes a strict readiness signal and rejects path-free or extra-field variants', () => {
    const ready = decodeWorkspaceWorkerReadySignal(readySignal());
    expect(ready.workspace.canonicalPath).toBe(workspace.canonicalPath);
    expect(() => decodeWorkspaceWorkerReadySignal({ ...ready, unexpected: 'field' })).toThrow();
    expect(() =>
      decodeWorkspaceWorkerReadySignal({
        ...ready,
        workspace: { projectId: workspace.projectId, workspaceDigest: workspace.workspaceDigest },
      }),
    ).toThrow();
  });

  test('resolves only explicit source/installed executables and never consults PATH', async () => {
    const observed: string[] = [];
    const resolver = createWorkspaceWorkerProcessExecutableResolver({
      source: '/repo/source-worker.ts',
      installed: '/repo/installed-worker',
      sourceBuildId: 'source-build',
      installedBuildId: 'installed-build',
      executableVerifier: ({ path, mode }) => {
        observed.push(`${mode}:${path}`);
        return path;
      },
    });
    await expect(resolver.resolve('source')).resolves.toEqual({
      path: '/repo/source-worker.ts',
      mode: 'source',
      buildId: 'source-build',
    });
    await expect(resolver.resolve('installed')).resolves.toEqual({
      path: '/repo/installed-worker',
      mode: 'installed',
      buildId: 'installed-build',
    });
    expect(observed).toEqual(['source:/repo/source-worker.ts', 'installed:/repo/installed-worker']);
    expect(() =>
      createWorkspaceWorkerProcessExecutableResolver({
        source: 'worker.ts',
        installed: '/repo/installed-worker',
        sourceBuildId: 'source-build',
        installedBuildId: 'installed-build',
      }),
    ).toThrow();
  });

  test('returns an explicit neutral environment without ambient process variables', async () => {
    const resolver = createNeutralWorkspaceWorkerEnvironmentResolver({
      cwd: workspace.canonicalPath,
      env: { KITE_WORKER_SCOPE_ID: 'scope-host' },
    });
    const environment = await resolver.resolve({
      workspace,
      workerScopeId: 'scope-host',
      workerInstanceId: 'instance-host',
      layoutGeneration: 'layout-1',
    });
    expect(environment).toEqual({
      cwd: workspace.canonicalPath,
      env: { KITE_WORKER_SCOPE_ID: 'scope-host' },
    });
    expect(environment.env).not.toHaveProperty('PATH');
  });

  test('uses the injectable Windows native runner and explicit runtime for source mode', async () => {
    let observed: WorkspaceWorkerProcessSpawnInput | undefined;
    const host = createWorkspaceWorkerProcessHost({
      platform: 'win32',
      runtimeExecutable: '/runtime/bun.exe',
      executableVerifier: ({ path }) => path,
      windowsRunner: {
        async spawn(input) {
          observed = input;
          return fakeChild();
        },
      },
    });
    const input: WorkspaceWorkerProcessSpawnInput = {
      executable: { path: '/repo/source-worker.ts', mode: 'source', buildId: 'build-host' },
      args: ['worker', 'run'],
      cwd: workspace.canonicalPath,
      env: { KITE_WORKER_SCOPE_ID: 'scope-host' },
      detached: true,
      stdout: 'ignore',
    };
    const child = await host.spawn(input);
    expect(child.pid).toBe(4242);
    expect(observed).toEqual(input);
    expect(
      resolveWorkspaceWorkerProcessSpawnCommand(
        input.executable,
        input.args,
        'win32',
        '/runtime/bun.exe',
      ),
    ).toEqual({
      command: '/runtime/bun.exe',
      args: ['/repo/source-worker.ts', 'worker', 'run'],
    });
  });

  test.skipIf(process.platform === 'win32')(
    'runs source entries through the explicit runtime with an empty environment',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-host-source-')));
      const workspaceRoot = realpathSync(mkdtempSync(join(root, 'workspace-')));
      const workerScript = join(root, 'worker-entry.mjs');
      const workspaceDigest = `sha256:${createHash('sha256').update(workspaceRoot).digest('hex')}`;
      writeFileSync(
        workerScript,
        `import { writeSync, closeSync } from 'node:fs';
const buildId = process.env.PATH === undefined ? 'empty-env-build' : 'ambient-env-build';
const value = {
  schema: 'kite.workspace-worker-ready.v1',
  identity: {
    role: 'worker', workerScopeId: 'scope-empty-env', instanceId: 'instance-empty-env',
    buildId, protocolVersion: 1,
    protocolRevision: 'kite-local-coordinator-protocol-v1',
    clientContractRevision: 'kite-local-coordinator-client-v1'
  },
  workspace: {
    canonicalPath: ${JSON.stringify(workspaceRoot)},
    projectId: ${JSON.stringify(`project_${workspaceDigest.slice('sha256:'.length)}`)},
    workspaceDigest: ${JSON.stringify(workspaceDigest)}
  },
  pid: process.pid, startedAt: '2026-08-29T00:00:00.000Z',
  processStartIdentity: 'empty-env-start',
  storeProfile: 'kite-coordinator-workspace-worker-web-v1-2026-08-28',
  layoutGeneration: 'layout-1',
  endpoint: { origin: 'http://127.0.0.1:43143', websocketUrl: 'ws://127.0.0.1:43143/rpc' },
  controlOrigin: 'http://127.0.0.1:43145'
};
writeSync(3, JSON.stringify(value) + '\\n');
closeSync(3);
`,
      );
      chmodSync(workerScript, 0o700);
      const host = createWorkspaceWorkerProcessHost({ runtimeExecutable: process.execPath });
      const child = await host.spawn({
        executable: { path: workerScript, mode: 'source', buildId: 'empty-env-build' },
        args: [],
        cwd: root,
        env: {},
        detached: true,
        stdout: 'ignore',
      });
      await expect(child.waitForReady()).resolves.toMatchObject({
        identity: { buildId: 'empty-env-build' },
      });
      await child.readiness.release();
      expect(child.waitForExit).toBeDefined();
      await child.waitForExit?.();
      rmSync(root, { recursive: true, force: true });
    },
  );

  test('requires exact regular canonical files and fails closed for symlinks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-worker-host-')));
    const file = join(root, 'worker.bin');
    const link = join(root, 'worker-link.bin');
    try {
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o700 });
      symlinkSync(file, link);
      expect(verifyWorkspaceWorkerProcessExecutable({ path: file, mode: 'installed' })).toBe(file);
      expect(() =>
        verifyWorkspaceWorkerProcessExecutable({ path: link, mode: 'installed' }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports alive only when PID and start identity both match, and never signals the process', async () => {
    const probe = createWorkspaceWorkerProcessProbe({
      readStartIdentity: async (_pid, _platform) => 'host-start-1',
    });
    await expect(
      probe.inspect({ pid: process.pid, processStartIdentity: 'host-start-1' }),
    ).resolves.toBe('alive');
    await expect(
      probe.inspect({ pid: process.pid, processStartIdentity: 'different-start' }),
    ).resolves.toBe('uncertain');
  });
});
