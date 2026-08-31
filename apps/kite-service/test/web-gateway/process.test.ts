import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorGatewayRegistration,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createWebGatewayProcessExecutableResolver,
  createWebGatewayProcessHost,
  createWebGatewayProcessLockIdentity,
  createWebGatewayProcessManager,
  createWebGatewayProcessStatePort,
  resolveWebGatewayProcessSpawnCommand,
  runWebGatewayMain,
  WEB_GATEWAY_PROCESS_DESCRIPTOR_SCHEMA_,
  WEB_GATEWAY_READY_SCHEMA_,
  type WebGatewayCarrier,
  type WebGatewayProcessChild,
  type WebGatewayProcessDescriptor,
  type WebGatewayProcessEnvironmentResolver,
  type WebGatewayProcessProbePort,
  type WebGatewayProcessSpawnPort,
  type WebGatewayProcessStatePort,
  type WebGatewayReadySignal,
  WebGatewayStaticAssetsError,
} from '../../src/web-gateway';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Web Gateway process state and native host', () => {
  test.skipIf(process.platform === 'win32')(
    'keeps state owner-only and rejects aliases/hardlinks',
    () => {
      const root = makeRoot();
      const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
      const value = makeDescriptor('gateway-state-1', 31_001);
      state.publishDescriptor(value);
      expect(state.readDescriptor()).resolves.toEqual(value);

      const alias = join(root, 'descriptor-alias');
      symlinkSync(state.paths.descriptor, alias);
      unlinkSync(state.paths.descriptor);
      symlinkSync(alias, state.paths.descriptor);
      expect(state.readDescriptor()).rejects.toMatchObject({ code: 'corrupt' });
      unlinkSync(state.paths.descriptor);

      writeFileSync(state.paths.descriptor, JSON.stringify(value));
      const hardlink = join(root, 'descriptor-hardlink');
      linkSync(state.paths.descriptor, hardlink);
      expect(state.readDescriptor()).rejects.toMatchObject({ code: 'corrupt' });
    },
  );

  test('requires explicit absolute executable files and rejects symlink/hardlink identities', async () => {
    const root = makeRoot();
    const source = join(root, 'gateway-source.js');
    const installed = join(root, 'gateway-installed.js');
    writeFileSync(source, 'source');
    writeFileSync(installed, 'installed');
    const resolver = createWebGatewayProcessExecutableResolver({
      source,
      installed,
      sourceBuildId: 'source-build',
      installedBuildId: 'installed-build',
    });
    await expect(resolver.resolve('source')).resolves.toMatchObject({
      path: realpathSync(source),
      buildId: 'source-build',
    });
    expect(() =>
      createWebGatewayProcessExecutableResolver({
        source: 'relative.js',
        installed,
        sourceBuildId: 'a',
        installedBuildId: 'b',
      }),
    ).toThrow();

    const symlink = join(root, 'gateway-symlink.js');
    symlinkSync(source, symlink);
    const symlinkResolver = createWebGatewayProcessExecutableResolver({
      source: symlink,
      installed,
      sourceBuildId: 'a',
      installedBuildId: 'b',
    });
    await expect(symlinkResolver.resolve('source')).rejects.toMatchObject({
      code: 'invalid_executable',
    });

    const hardlink = join(root, 'gateway-hardlink.js');
    linkSync(source, hardlink);
    const hardlinkResolver = createWebGatewayProcessExecutableResolver({
      source: hardlink,
      installed,
      sourceBuildId: 'a',
      installedBuildId: 'b',
    });
    await expect(hardlinkResolver.resolve('source')).rejects.toMatchObject({
      code: 'invalid_executable',
    });
  });

  test.skipIf(process.platform === 'win32')(
    'reads exactly one bounded fd3 readiness frame',
    async () => {
      const root = makeRoot();
      const script = join(root, 'ready-gateway.mjs');
      const ready = JSON.stringify(readySignal(42_001, 'host-start'));
      writeFileSync(
        script,
        `#!${process.execPath}\nimport { writeSync, closeSync } from 'node:fs';\nwriteSync(3, ${JSON.stringify(`${ready}\n`)});\ncloseSync(3);\n`,
      );
      chmodSync(script, 0o700);
      const host = createWebGatewayProcessHost({ runtimeExecutable: process.execPath });
      const executable = {
        path: script,
        mode: 'source' as const,
        buildId: 'gateway-build-1',
      };
      expect(
        resolveWebGatewayProcessSpawnCommand(executable, ['web-gateway', 'run'], 'linux').command,
      ).toBe(process.execPath);
      expect(
        resolveWebGatewayProcessSpawnCommand(
          { ...executable, mode: 'installed' },
          ['web-gateway', 'run'],
          'linux',
        ).command,
      ).toBe(executable.path);
      const child = await host.spawn({
        executable,
        args: [],
        cwd: root,
        env: {},
        detached: true,
        stdout: 'ignore',
      });
      await expect(child.waitForReady()).resolves.toMatchObject({
        schema: WEB_GATEWAY_READY_SCHEMA_,
        pid: 42_001,
        processStartIdentity: 'host-start',
      });
      await child.readiness.release();

      const duplicateScript = join(root, 'duplicate-ready-gateway.mjs');
      writeFileSync(
        duplicateScript,
        `#!${process.execPath}\nimport { writeSync, closeSync } from 'node:fs';\nwriteSync(3, ${JSON.stringify(`${ready}\n${ready}\n`)});\ncloseSync(3);\n`,
      );
      chmodSync(duplicateScript, 0o700);
      const duplicateChild = await host.spawn({
        executable: { ...executable, path: duplicateScript },
        args: [],
        cwd: root,
        env: {},
        detached: true,
        stdout: 'ignore',
      });
      await expect(duplicateChild.waitForReady()).rejects.toMatchObject({ code: 'ready_failed' });
      await duplicateChild.readiness.release();
    },
  );
});

describe('Web Gateway process manager', () => {
  test('single-flights ensure, preserves path-free registration, and reuses the loopback URL', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    const first = createWebGatewayProcessManager(fake.options);
    const [one, two] = await Promise.all([first.ensure(), first.ensure()]);
    expect(fake.spawnCount).toBe(1);
    expect(one.registration.endpoint).toEqual({ origin: 'http://127.0.0.1:43177' });
    expect(JSON.stringify(one)).not.toContain(root);
    expect(one.launchUrl).toBe(two.launchUrl);
    expect(fake.registrations).toHaveLength(2);

    const restarted = createWebGatewayProcessManager({
      ...fake.options,
      controlLinkFor: async () => fake.control,
    });
    const discovered = await restarted.discover();
    expect(discovered?.registration.identity.instanceId).toBe('gateway-process-1');
    expect(discovered?.launchUrl).toBe(one.launchUrl);
    expect(fake.spawnCount).toBe(1);

    await restarted.stop();
    expect(fake.stopCount).toBe(1);
    await expect(state.readDescriptor()).resolves.toBeUndefined();
  });

  test('does not replace an uncertain stale instance or lifecycle owner', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    const value = makeDescriptor('stale-gateway', 42_002);
    state.publishDescriptor(value);
    state.publishControlCredential('s'.repeat(43));
    const lock = createWebGatewayProcessLockIdentity({
      kind: 'instance',
      pid: value.pid,
      instanceId: value.identity.instanceId,
      startedAt: value.startedAt,
      processStartIdentity: value.processStartIdentity,
      buildId: value.identity.buildId,
      operation: 'ensure',
    });
    const lease = await state.acquireLock('instance', lock);
    expect(lease).toBeDefined();
    const manager = createWebGatewayProcessManager({
      ...fake.options,
      process: { inspect: async () => 'uncertain' },
    });
    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'identity_uncertain' });
    await expect(state.readDescriptor()).resolves.toEqual(value);
    await lease?.release();
  });

  test('does not replay a credential-only launch with an unknown spawn outcome', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    const credential = 'u'.repeat(43);
    await state.publishControlCredential(credential);
    const manager = createWebGatewayProcessManager(fake.options);

    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'recovery_required' });
    expect(fake.spawnCount).toBe(0);
    await expect(state.readControlCredential()).resolves.toBe(credential);
  });

  test('fails asset preflight before writing launch state or spawning', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    const manager = createWebGatewayProcessManager({
      ...fake.options,
      preflightStaticAssets: () => {
        throw new WebGatewayStaticAssetsError();
      },
    });

    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'web_assets_missing' });
    expect(fake.spawnCount).toBe(0);
    await expect(state.readLaunchIntent()).resolves.toBeUndefined();
    await expect(state.readControlCredential()).resolves.toBeUndefined();
  });

  test('cleans a confirmed-dead readiness failure and retries without a duplicate Gateway', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    fake.failNextReadiness('dead');
    const manager = createWebGatewayProcessManager(fake.options);

    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'ready_mismatch' });
    await expect(state.readLaunchIntent()).resolves.toBeUndefined();
    await expect(state.readControlCredential()).resolves.toBeUndefined();
    await expect(manager.ensure()).resolves.toMatchObject({
      registration: { identity: { instanceId: 'gateway-process-1' } },
    });
    expect(fake.spawnCount).toBe(2);
    expect(fake.registrations).toHaveLength(1);
  });

  test('preserves uncertain readiness state until explicit stop proves the child dead', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    fake.failNextReadiness('uncertain');
    const manager = createWebGatewayProcessManager(fake.options);

    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'identity_uncertain' });
    await expect(state.readLaunchIntent()).resolves.toBeDefined();
    await expect(state.readControlCredential()).resolves.toBeDefined();
    await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'identity_uncertain' });
    expect(fake.spawnCount).toBe(1);
    fake.setProcessStatus('dead');
    await expect(manager.detailedStop()).resolves.toBe('closed');
    await expect(state.readLaunchIntent()).resolves.toBeUndefined();
    await expect(state.readControlCredential()).resolves.toBeUndefined();
  });

  test('recovers a confirmed-dead Gateway after its child lock was released before parent cleanup', async () => {
    const root = makeRoot();
    const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
    const fake = createFakeRuntime(state, root);
    const stale = makeDescriptor('stale-gateway-without-child-lock', 42_002);
    await state.publishDescriptor(stale);
    await state.publishControlCredential('s'.repeat(43));
    const manager = createWebGatewayProcessManager({
      ...fake.options,
      process: {
        inspect: async ({ pid }) => (pid === stale.pid ? 'dead' : 'alive'),
      },
    });

    await expect(manager.ensure()).resolves.toMatchObject({
      registration: { identity: { instanceId: 'gateway-process-1' } },
    });
    expect(fake.spawnCount).toBe(1);
    await expect(state.readDescriptor()).resolves.toMatchObject({
      identity: { instanceId: 'gateway-process-1' },
    });
  });

  test('does not recover a missing child lock while its descriptor process is alive or uncertain', async () => {
    for (const processStatus of ['alive', 'uncertain'] as const) {
      const root = makeRoot();
      const state = createWebGatewayProcessStatePort(createKiteHomeIdentity(root));
      const fake = createFakeRuntime(state, root);
      const stale = makeDescriptor(`gateway-missing-lock-${processStatus}`, 42_003);
      await state.publishDescriptor(stale);
      await state.publishControlCredential('s'.repeat(43));
      const manager = createWebGatewayProcessManager({
        ...fake.options,
        process: { inspect: async () => processStatus },
      });

      await expect(manager.ensure()).rejects.toMatchObject({ diagnostic: 'state_corrupt' });
      expect(fake.spawnCount).toBe(0);
      await expect(state.readDescriptor()).resolves.toEqual(stale);
    }
  });
});

describe('Web Gateway process main', () => {
  test('accepts only exact args, acquires child instance lock, publishes readiness, and closes once', async () => {
    const root = makeRoot();
    let shutdown: (() => void) | undefined;
    let closed = 0;
    let ready: WebGatewayReadySignal | undefined;
    const carrier = {
      origin: 'http://127.0.0.1:43178',
      close: async () => {
        closed += 1;
      },
    } as unknown as WebGatewayCarrier;
    const run = runWebGatewayMain(['web-gateway', 'run'], {
      environment: {
        KITE_WEB_GATEWAY_HOME: root,
        KITE_WEB_GATEWAY_STATIC_ROOT: root,
        KITE_WEB_GATEWAY_BUILD_ID: 'main-build',
        KITE_WEB_GATEWAY_INSTANCE_ID: 'main-instance',
        KITE_WEB_GATEWAY_CONTROL_CREDENTIAL: 'c'.repeat(43),
        KITE_WEB_GATEWAY_READY_FD: '9',
      },
      createCarrier: async () => carrier,
      signals: {
        subscribe(listener) {
          shutdown = listener;
          return () => undefined;
        },
      },
      writeReady(value) {
        ready = value;
      },
      readProcessStartIdentity: async () => 'main-start',
    });
    await Bun.sleep(1);
    expect(ready?.identity.instanceId).toBe('main-instance');
    expect(
      readFileSync(join(root, 'web-gateway', 'v1', 'instance.lock', 'identity.json'), 'utf8'),
    ).toContain('main-instance');
    shutdown?.();
    await run;
    expect(closed).toBe(1);
    expect(() => readFileSync(join(root, 'web-gateway', 'v1', 'instance.lock'))).toThrow();
  });

  test('rejects missing manager environment and unknown entry args', async () => {
    await expect(runWebGatewayMain(['web-gateway', 'status'], {})).rejects.toThrow('exact');
    await expect(
      runWebGatewayMain(['web-gateway', 'run'], {
        environment: {},
        createCarrier: async () => {
          throw new Error('must not compose');
        },
      }),
    ).rejects.toThrow('explicit KITE_WEB_GATEWAY_HOME');
  });

  test('lets the native carrier request process shutdown after its response flushes', async () => {
    const root = makeRoot();
    let requestShutdown: (() => void) | undefined;
    let closed = 0;
    const run = runWebGatewayMain(['web-gateway', 'run'], {
      environment: {
        KITE_WEB_GATEWAY_HOME: root,
        KITE_WEB_GATEWAY_STATIC_ROOT: root,
        KITE_WEB_GATEWAY_BUILD_ID: 'main-build',
        KITE_WEB_GATEWAY_INSTANCE_ID: 'main-native-stop',
        KITE_WEB_GATEWAY_CONTROL_CREDENTIAL: 'd'.repeat(43),
        KITE_WEB_GATEWAY_READY_FD: '9',
      },
      createCarrier: async (_environment, stop) => {
        requestShutdown = stop;
        return {
          origin: 'http://127.0.0.1:43179',
          close: async () => {
            closed += 1;
          },
        } as unknown as WebGatewayCarrier;
      },
      signals: { subscribe: () => () => undefined },
      writeReady: () => undefined,
      readProcessStartIdentity: async () => 'main-start-native-stop',
    });
    await Bun.sleep(1);
    requestShutdown?.();
    await run;
    expect(closed).toBe(1);
  });
});

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'kite-web-gateway-process-')));
  roots.push(root);
  return root;
}

function identity(instanceId: string, buildId = 'gateway-build-1') {
  return {
    role: 'web_gateway' as const,
    instanceId,
    buildId,
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  };
}

function readySignal(pid: number, processStartIdentity: string): WebGatewayReadySignal {
  return {
    schema: WEB_GATEWAY_READY_SCHEMA_,
    identity: identity('gateway-process-1'),
    pid,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity,
    endpoint: { origin: 'http://127.0.0.1:43177' },
  };
}

function makeDescriptor(instanceId: string, pid: number): WebGatewayProcessDescriptor {
  return {
    schema: WEB_GATEWAY_PROCESS_DESCRIPTOR_SCHEMA_,
    identity: identity(instanceId),
    pid,
    startedAt: '2026-08-29T00:00:00.000Z',
    processStartIdentity: `start-${instanceId}`,
    endpoint: { origin: 'http://127.0.0.1:43177' },
  };
}

function createFakeRuntime(state: WebGatewayProcessStatePort, root: string) {
  let processStatus: 'alive' | 'dead' | 'uncertain' = 'alive';
  let nextReadinessFailure: 'dead' | 'uncertain' | undefined;
  let spawnCount = 0;
  let stopCount = 0;
  let instanceLease: Awaited<ReturnType<WebGatewayProcessStatePort['acquireLock']>>;
  const registrations: CoordinatorGatewayRegistration[] = [];
  const control = {
    async mintLaunchUrl() {
      return 'http://127.0.0.1:43177';
    },
    async stop() {
      stopCount += 1;
      processStatus = 'dead';
      await instanceLease?.release();
    },
  };
  const ready = readySignal(42_001, 'child-start-1');
  const child: WebGatewayProcessChild = {
    pid: ready.pid,
    readiness: { release: async () => undefined },
    control,
    waitForReady: async () => {
      if (nextReadinessFailure) {
        processStatus = nextReadinessFailure;
        nextReadinessFailure = undefined;
        if (processStatus === 'dead') await instanceLease?.release();
        throw new Error('synthetic readiness failure');
      }
      return ready;
    },
  };
  const executable = {
    path: join(root, 'gateway-executable'),
    mode: 'source' as const,
    buildId: 'gateway-build-1',
  };
  writeFileSync(executable.path, 'fake');
  const options = {
    state,
    executableResolver: { resolve: async () => executable },
    environment: {
      resolve: async () => ({ cwd: root, env: {} }),
    } as WebGatewayProcessEnvironmentResolver,
    spawn: {
      spawn: async () => {
        spawnCount += 1;
        processStatus = 'alive';
        instanceLease = await state.acquireLock(
          'instance',
          createWebGatewayProcessLockIdentity({
            kind: 'instance',
            pid: ready.pid,
            instanceId: ready.identity.instanceId,
            startedAt: ready.startedAt,
            processStartIdentity: ready.processStartIdentity,
            buildId: ready.identity.buildId,
            operation: 'ensure',
          }),
        );
        return child;
      },
    } as WebGatewayProcessSpawnPort,
    process: {
      inspect: async () => processStatus,
    } as WebGatewayProcessProbePort,
    preflightStaticAssets: () => undefined,
    readChildProcessStartIdentity: async () => ready.processStartIdentity,
    registry: {
      register: (value: CoordinatorGatewayRegistration) => {
        registrations.push(value);
      },
      unregister: (instanceId: string) => {
        const index = registrations.findIndex((value) => value.identity.instanceId === instanceId);
        if (index >= 0) registrations.splice(index, 1);
      },
    },
    managerProcessStartIdentity: 'manager-start',
    createGatewayInstanceId: () => 'gateway-process-1',
    operationTimeoutMs: 2_000,
    startupTimeoutMs: 2_000,
  };
  return {
    options,
    control,
    get spawnCount() {
      return spawnCount;
    },
    get stopCount() {
      return stopCount;
    },
    get registrations() {
      return registrations;
    },
    failNextReadiness(status: 'dead' | 'uncertain') {
      nextReadinessFailure = status;
    },
    setProcessStatus(status: 'alive' | 'dead' | 'uncertain') {
      processStatus = status;
    },
  };
}
