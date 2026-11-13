import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { Json } from '@kite-ai/agent/extensions';
import { expect, mock, test } from '#kite-test';
import { serve as fixtureServe } from '../../../../scripts/tooling/http';
import type { Subprocess } from '../../../../scripts/tooling/process';
import { spawn as spawnProcess } from '../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../scripts/tooling/test-command';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';

const flag = '--owned-source-publication-child';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown) => value as Record<string, Json>;
async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw Error('source_publication_deadline');
    await sleepTimer(5);
  }
}

/** Only this owned child mutates module bindings; the real Service/Runtime/SQL remain intact. */
async function faultChild(root: string, packetPath: string) {
  const actual = { ...fs };
  const workspace = join(root, 'workspace'),
    project = join(workspace, '.kite-code', 'mcp.json');
  actual.mkdirSync(dirname(project), { recursive: true, mode: 0o700 });
  actual.writeFileSync(project, '// original comment\n{"keep":true,"mcpServers":{}}\n', {
    mode: 0o600,
  });
  const before = actual.readFileSync(project);
  const paths = new Map<number, string>();
  const sourceLockFds = new Set<number>();
  const windowsSourceLocks = new Set<unknown>();
  let armed = false,
    published = false,
    publicationFaults = 0,
    releaseFaults = 0,
    renames = 0,
    realFlushes = 0,
    vault = 0,
    rpc = 0;
  mock.module('node:fs', () => ({
    ...actual,
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = actual.openSync(...args);
      const path = typeof args[0] === 'string' ? args[0] : args[0].toString();
      paths.set(fd, path);
      if (
        path.startsWith(root) &&
        ['/mcp.json.lock', '/mcp-approvals.json.lock', '/mcp-auth-bindings.json.lock'].some(
          (suffix) => path.endsWith(suffix),
        )
      )
        sourceLockFds.add(fd);
      return fd;
    },
    renameSync(...args: Parameters<typeof fs.renameSync>) {
      actual.renameSync(...args);
      if (armed && args[1] === project) {
        published = true;
        renames++;
      }
    },
    fsyncSync(fd: number) {
      if (armed && published && paths.get(fd) === dirname(project) && publicationFaults === 0) {
        publicationFaults++;
        throw Error('owned_directory_fsync_failure');
      }
      actual.fsyncSync(fd);
      realFlushes++;
    },
    closeSync(fd: number) {
      const path = paths.get(fd);
      actual.closeSync(fd);
      paths.delete(fd);
      sourceLockFds.delete(fd);
      if (armed && publicationFaults === 1 && path === `${project}.lock` && releaseFaults === 0) {
        releaseFaults++;
        // Kernel close really completed; only the post-close error is injected.
        throw Error('owned_lock_release_failure');
      }
    },
  }));
  if (process.platform === 'win32') {
    const securityModule = new URL(
      '../../../../packages/agent/src/platform/windows-path-security.ts',
      import.meta.url,
    ).href;
    const security = await import(securityModule);
    const native = security.defaultWindowsPathSecurity()!;
    const scoped = {
      ...native,
      writeScopeFile(path: string, bytes: Uint8Array) {
        native.writeScopeFile(path, bytes);
        realFlushes++; // The original Windows writer completed FlushFileBuffers.
      },
      readScopeFile(path: string, maxBytes: number, privateFile?: boolean) {
        const value = native.readScopeFile(path, maxBytes, privateFile);
        if (armed && published && path === project && publicationFaults === 0) {
          publicationFaults++;
          throw Error('owned_post_publication_readback_failure');
        }
        return value;
      },
    };
    mock.module(securityModule, () => ({ ...security, defaultWindowsPathSecurity: () => scoped }));
    const lockModule = new URL('../../../../packages/agent/src/platform/locks.ts', import.meta.url)
      .href;
    const locks = await import(lockModule);
    const acquire = locks.acquireFileLock,
      assertLive = locks.assertLiveLock;
    const originals = new WeakMap();
    mock.module(lockModule, () => ({
      ...locks,
      acquireFileLock(...args: Parameters<typeof acquire>) {
        const original = acquire(...args);
        const proxy = {
          ...original,
          release() {
            original.release();
            windowsSourceLocks.delete(original);
            if (
              armed &&
              publicationFaults === 1 &&
              original.path === `${project}.lock` &&
              releaseFaults === 0
            ) {
              releaseFaults++;
              throw Error('owned_lock_release_failure');
            }
          },
        };
        if (original.path.startsWith(root)) windowsSourceLocks.add(original);
        originals.set(proxy, original);
        return proxy;
      },
      assertLiveLock(
        lock: Parameters<typeof assertLive>[0],
        ...args: [string, 'shared' | 'exclusive']
      ) {
        return assertLive(
          (typeof lock === 'object' && lock !== null ? originals.get(lock) : undefined) ?? lock,
          ...args,
        );
      },
    }));
  }
  const { createRuntime } = await import('@kite-ai/agent');
  const { initializeLivePermissionFixture } = await import('../fixtures/live-permission-fixture');
  const { createArtifactStore } = await import('@kite-ai/agent/artifacts');
  const { createTemporaryCredentialBackend } = await import('@kite-ai/agent/config');
  const { selectProfile } = await import('@kite-ai/agent/profile');
  const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
  const { getLoadedSqliteEngine } = await import('@kite-ai/agent/sqlite-engine');
  const { createClient } = await import('@kite-ai/client');
  const { Database } = await import('@kite-ai/agent/runtime-sqlite');
  const { createDefaultProcessConfiguration } = await import('../../src/configuration');
  const { startService } = await import('../../src/index');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  actual.writeFileSync(join(profile.profilePath, 'mcp.json'), '{"mcpServers":{}}\n', {
    mode: 0o600,
  });
  const remote = await fixtureServe({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      rpc++;
      return new Response('unexpected transport', { status: 500 });
    },
  });
  const backend = createTemporaryCredentialBackend();
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    profile,
    observerSubjectId: 'owner',
    credentialBackend: {
      kind: backend.kind,
      async put(id, value) {
        vault++;
        await backend.put(id, value);
      },
      async resolve(id) {
        vault++;
        return backend.resolve(id);
      },
      async remove(id) {
        vault++;
        await backend.remove(id);
      },
    },
    permissionPolicy: {
      readPolicy: (request) => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'owned-publication-policy',
        allowed: [
          {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
          },
        ],
      }),
    },
  });
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: ReturnType<typeof createClient> | undefined;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  const cleanupErrors: string[] = [];
  const packet: Record<string, unknown> = { childPid: process.pid };
  try {
    store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
    const storeId = (await store.getMetadata()).storeId;
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({
        profile: { dataRoot: profile.dataRoot, profile: profile.profile },
        store,
      }),
      permissions: host.permissions!,
      extensions: host.extensions,
      conditions: host.conditions,
      initializeRunRequirements: host.initializeRunRequirements,
      resolveRunConfiguration: host.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: host.resolveRecoveryRunConfiguration,
      supportsExtensionInputs: host.supportsExtensionInputs,
    });
    host.permissionManagement?.(runtime);
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(`${workspace}/`).href,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'owned',
    });
    await initializeLivePermissionFixture({
      runtime,
      profile,
      expectedStoreId: storeId,
      subjectId: 'owner',
      sessionId: 's',
      workspaceId: 'w',
      mode: 'full',
      trusted: true,
    });
    service = await startService({
      runtime,
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      buildId: 'owned-source-publication',
      subjectId: 'owner',
    });
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['extension_queries', 'extensions_actions'],
      },
    });
    await client.connect();
    const directory = await client.queryExtension('s', 'builtin.mcp.sources', 'mcp.sources', {});
    const request = {
      kind: 'extension.invoke' as const,
      expectedStoreId: storeId,
      commandId: 'original-publication',
      extensionId: 'builtin.mcp.sources',
      actionId: 'mcp.source.add',
      definitionVersion: '1',
      input: {
        scope: 'workspace',
        name: 'published',
        entry: { type: 'http', url: `http://127.0.0.1:${remote.port}/mcp` },
        expectedReadSet: object(directory[0]!.payload).readSet!,
      },
    };
    armed = true;
    await client.invokeExtension('s', request);
    const execution = await until(async () => {
      const c = await runtime.getCommand(request.commandId);
      const id = object(c?.receipt).executionId;
      if (typeof id !== 'string') return null;
      const e = await runtime.getExecution(id);
      return e && ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(e.status)
        ? e
        : null;
    });
    const originalCommand = await client.getCommand(request.commandId);
    const mutation = await runtime.getHostMutation({
      expectedStoreId: storeId,
      commandId: `mcp-entry-${execution.id}`,
      subjectId: 'owner',
    });
    const history = await client.queryExtension(
      's',
      'builtin.mcp.sources',
      'mcp.source.mutation.result',
      { commandId: request.commandId },
    );
    const after = actual.readFileSync(project);
    const source = JSON.parse(after.toString('utf8').replace('// original comment\n', ''));
    await client.invokeExtension('s', request);
    const repeatedCommand = await client.getCommand(request.commandId);
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      packet.model = object(
        db.query("SELECT COUNT(*) AS n FROM execution WHERE kind='model'").get(),
      ).n;
      packet.runs = object(db.query('SELECT COUNT(*) AS n FROM run').get()).n;
      packet.transportExecutions = object(
        db
          .query(
            "SELECT COUNT(*) AS n FROM execution WHERE adapter_id LIKE 'mcp.connection.%' OR adapter_id='mcp.source.connection'",
          )
          .get(),
      ).n;
      packet.actionCommands = object(
        db.query("SELECT COUNT(*) AS n FROM command WHERE kind='extension.invoke'").get(),
      ).n;
    } finally {
      db.close();
    }
    Object.assign(packet, {
      storeId,
      commandId: request.commandId,
      executionId: execution.id,
      executionStatus: execution.status,
      executionResult: execution.result,
      mutation,
      command: originalCommand,
      history,
      marker: source.mcpServers.published._kiteSourceCreation,
      sourceBeforeSha: hash(before),
      sourceAfterSha: hash(after),
      commentRetained: after.toString().startsWith('// original comment\n'),
      unrelatedRetained: source.keep === true,
      repeatedSameCommand:
        repeatedCommand.id === originalCommand.id &&
        JSON.stringify(repeatedCommand.receipt) === JSON.stringify(originalCommand.receipt),
      duplicateBytesUnchanged: actual.readFileSync(project).equals(after),
      sqlite: getLoadedSqliteEngine(),
    });
  } catch (error) {
    packet.failure = error instanceof Error ? error.message.slice(0, 160) : 'unknown';
    process.exitCode = 1;
  } finally {
    armed = false;
    try {
      client?.disposeNetwork();
    } catch {
      cleanupErrors.push('client_close');
    }
    try {
      await service?.close();
    } catch {
      cleanupErrors.push('service_close');
    }
    try {
      await store?.close();
    } catch {
      cleanupErrors.push('store_close');
    }
    try {
      remote.stop(true);
    } catch {
      cleanupErrors.push('remote_close');
    }
    Object.assign(packet, {
      published,
      renames,
      publicationFaults,
      releaseFaults,
      realFlushes,
      sourceLocksRemaining: sourceLockFds.size + windowsSourceLocks.size,
      vault,
      rpc,
      cleanupErrors,
      cleanupConfirmed:
        cleanupErrors.length === 0 && sourceLockFds.size === 0 && windowsSourceLocks.size === 0,
    });
    actual.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
}

if (process.argv.includes(flag)) {
  await faultChild(
    process.argv[process.argv.indexOf(flag) + 1]!,
    process.argv[process.argv.indexOf(flag) + 2]!,
  );
} else {
  test('published source remains unknown across platform read-back/sync plus lock-release failure; original duplicate never writes again', async () => {
    const root = fs.realpathSync(temporaryDirectory('kite-service-source-publication-'));
    fs.chmodSync(root, 0o700);
    const evidence = temporaryDirectory('kite-source-publication-evidence-');
    const packetPath = join(evidence, 'packet.json');
    const logFd = fs.openSync(
      join(evidence, 'child.log'),
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    let child: Subprocess | undefined;
    let passed = false;
    try {
      child = spawnProcess(
        [process.execPath, ...testRuntimeFlags, import.meta.filename, flag, root, packetPath],
        {
          stdin: 'ignore',
          stdout: logFd,
          stderr: logFd,
        },
      );
      const exit = await child.exited;
      const p = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      console.log(`source-publication-evidence ${evidence}`);
      expect(exit).toBe(0);
      expect(p.failure).toBeUndefined();
      expect(p.cleanupConfirmed).toBe(true);
      expect(p.cleanupErrors).toEqual([]);
      expect(p.sourceLocksRemaining).toBe(0);
      expect(p.published).toBe(true);
      expect(p.renames).toBe(1);
      expect(p.publicationFaults).toBe(1);
      expect(p.releaseFaults).toBe(1);
      expect(p.realFlushes).toBeGreaterThan(0);
      expect(p.sourceBeforeSha).not.toBe(p.sourceAfterSha);
      expect(p.commentRetained).toBe(true);
      expect(p.unrelatedRetained).toBe(true);
      expect(p.marker).toEqual({ version: 1, operationId: p.executionId });
      expect(p.executionStatus).toBe('outcome_unknown');
      expect(p.executionResult.outcome).toBe('outcome_unknown');
      expect(p.executionResult.details).toMatchObject({
        code: 'mcp_source_publication_unknown',
        effectAttempted: true,
        connectionAttempted: false,
        credentialLookupAttempted: false,
        credentialRevocationAttempted: false,
        modelAttempted: false,
        receipt: null,
      });
      expect(p.mutation).toMatchObject({
        id: `mcp-entry-${p.executionId}`,
        state: 'outcome_unknown',
        receipt: { status: 'outcome_unknown', code: 'mcp_source_publication_unknown' },
      });
      expect(p.command.id).toBe(p.commandId);
      expect(p.command.receipt.executionId).toBe(p.executionId);
      expect(p.history).toHaveLength(1);
      expect(p.history[0].artifactRefs).toEqual([]);
      expect(p.history[0].actions).toEqual([]);
      expect(p.history[0].payload).toMatchObject({ phase: 'outcome_unknown', receipt: null });
      expect(p.repeatedSameCommand).toBe(true);
      expect(p.duplicateBytesUnchanged).toBe(true);
      expect(p.actionCommands).toBe(1);
      expect(p.model).toBe(0);
      expect(p.runs).toBe(0);
      expect(p.transportExecutions).toBe(0);
      expect(p.vault).toBe(0);
      expect(p.rpc).toBe(0);
      passed = true;
    } finally {
      if (child?.exitCode === null) child.kill();
      if (child) await child.exited;
      fs.closeSync(logFd);
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      fs.writeFileSync(
        join(evidence, 'cleanup.json'),
        `${JSON.stringify({ heldChildExit: child?.exitCode, rootRemoved: !fs.existsSync(root), retainedRoot: fs.existsSync(root) ? root : null })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    }
  }, 15000);
}
