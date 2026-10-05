import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { startService } from '@kite-ai/service';
import { readDaemonReservation, selectDaemonEndpoint } from '@kite-ai/service/daemon';
import { assertSharedWorkspace, connectSharedService } from '../../host/shared-service';

const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
test('Node import outside the checkout does not load the native daemon entry', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-shared-import-'));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, '../../host/shared-service.ts')],
      target: 'node',
      external: ['@kite-ai/service/daemon'],
      outdir: root,
    });
    expect(build.success).toBe(true);
    const url = pathToFileURL(join(root, 'shared-service.js')).href;
    const child = Bun.spawn(
      [
        'node',
        '--input-type=module',
        '-e',
        `const entry=await import(${JSON.stringify(url)});if(typeof entry.connectSharedService!=='function')throw Error('missing_entry');console.log('IMPORT_ONLY');`,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const [out, err, exit] = await bounded(
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]),
        'shared_import_timeout',
      );
      expect(exit).toBe(0);
      expect(err).toBe('');
      expect(out).toBe('IMPORT_ONLY\n');
      expect(existsSync(join(root, 'node_modules'))).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
async function bounded<T>(work: Promise<T>, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(code)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function barrier() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((r) => (enter = r)),
    waiting: new Promise<void>((r) => (release = r)),
    enter: () => enter(),
    release: () => release(),
  };
}
async function fixture(diagnostic = false, drift = false) {
  const { reserveDaemonEndpoint } = await import(
    new URL('../../../service/src/daemon/endpoint.ts', import.meta.url).href
  );
  const root = realpathSync(mkdtempSync('/private/tmp/kite-shared-client-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const held = barrier();
  let calls = 0;
  const store = diagnostic ? undefined : await openSqliteStore(profile);
  const runtime = store
    ? createRuntime({
        store,
        modelId: 'fixed',
        model: {
          async *stream() {
            calls++;
            held.enter();
            await held.waiting;
            yield { type: 'text_delta' as const, text: 'original held work completed' };
            yield {
              type: 'finish' as const,
              reason: 'stop' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'fixed' };
          },
        },
      })
    : undefined;
  const identity = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: identity,
    instanceId: 'original-instance',
    buildId: 'running-build-not-client-build',
    subjectId: 'owner',
  });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(root, 'd.sock'),
  });
  const owner = await reserveDaemonEndpoint(endpoint, {
    profile: identity,
    instanceId: drift ? 'wrong-instance' : service.bootstrap.instanceId,
    buildId: service.bootstrap.buildId,
    workspace,
  });
  await owner.listen({
    httpEndpoint: service.endpoint,
    token: service.bootstrap.token,
    webOrigin: service.endpoint,
  });
  const connect = (extra: Partial<Parameters<typeof connectSharedService>[0]> = {}) =>
    connectSharedService({
      profile,
      server: endpoint.socket,
      requiredCapabilities: ['sessions', 'commands', 'history'],
      ...extra,
    });
  return {
    root,
    profile,
    workspace,
    store,
    runtime,
    service,
    owner,
    endpoint,
    held,
    connect,
    calls: () => calls,
    async cleanup() {
      held.release();
      await service.close();
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function remoteFixture(drift = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-shared-remote-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const child = Bun.spawn(
    [
      'bun',
      join(import.meta.dir, '../fixtures/shared-service-child.ts'),
      root,
      drift ? 'drift' : 'original',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const errors = new Response(child.stderr).text();
  const output = child.stdout.getReader();
  const cleanup = async () => {
    child.stdin.end();
    try {
      expect(await bounded(child.exited, 'shared_child_exit_timeout')).toBe(0);
      expect(await bounded(errors, 'shared_child_stderr_timeout')).toBe('');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await output.cancel();
      output.releaseLock();
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    await bounded(
      (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let text = '';
        while (!text.includes('\n')) {
          const frame = await output.read();
          if (frame.done) throw Error('shared_child_not_ready');
          text += decoder.decode(frame.value, { stream: true });
          if (text.length > 64) throw Error('shared_child_invalid_ready');
        }
        if (text !== 'READY\n') throw Error('shared_child_invalid_ready');
      })(),
      'shared_child_ready_timeout',
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'shared_child_startup_failed');
    }
    throw error;
  }
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: join(root, 'd.sock'),
  });
  const connect = (extra: Partial<Parameters<typeof connectSharedService>[0]> = {}) =>
    connectSharedService({
      profile,
      server: endpoint.socket,
      requiredCapabilities: ['sessions', 'commands', 'history'],
      ...extra,
    });
  return {
    root,
    profile,
    workspace,
    endpoint,
    connect,
    cleanup,
  };
}

nativeTest(
  'shared clients detach independently without stopping Service or cancelling held original work',
  async () => {
    const f = await fixture();
    try {
      const metadata = await f.store!.getMetadata();
      await f.runtime!.createWorkspace({
        expectedStoreId: metadata.storeId,
        id: 'w',
        name: 'fixed',
        rootUri: new URL(`file://${f.workspace}`).href,
      });
      await f.runtime!.createSession({
        expectedStoreId: metadata.storeId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 'a',
        workspaceId: 'w',
        title: 'owned',
      });
      const a = await f.connect(),
        b = await f.connect({ workspace: '.', cwd: f.workspace });
      expect(a.mode).toBe('shared');
      expect(a.fixedWorkspace).toBe(f.workspace);
      expect(a.bootstrap.buildId).toBe('running-build-not-client-build');
      const command = await a.client.startRun('a', {
        kind: 'run.start',
        expectedStoreId: metadata.storeId,
        commandId: 'held',
        content: 'work',
      });
      await f.held.entered;
      const firstClose = a.close();
      expect(a.close()).toBe(firstClose);
      await firstClose;
      await b.close();
      expect((await f.runtime!.getView('a')).runs[0]?.status).toBe('running');
      expect(f.runtime!.getLifecycleState().state).toBe('accepting');
      expect(readDaemonReservation(f.endpoint)?.instanceId).toBe(a.bootstrap.instanceId);
      const c = await f.connect();
      f.held.release();
      await f.runtime!.waitForCommand(command.id);
      expect((await c.client.getView('a')).runs[0]?.status).toBe('completed');
      expect(f.calls()).toBe(1);
      await c.close();
    } finally {
      await f.cleanup();
    }
  },
  10000,
);

nativeTest(
  'profile, capability, explicit workspace and bootstrap HTTP identity failures produce zero business effects',
  async () => {
    const f = await remoteFixture();
    try {
      await expect(
        f.connect({ profile: selectProfile({ dataRoot: f.profile.dataRoot, profile: 'other' }) }),
      ).rejects.toMatchObject({ code: 'shared_bootstrap_failed' });
      await expect(f.connect({ requiredCapabilities: ['not-a-capability'] })).rejects.toMatchObject(
        { code: 'shared_connection_failed' },
      );
      await expect(f.connect({ workspace: f.root })).rejects.toMatchObject({
        code: 'shared_workspace_mismatch',
      });
      const database = new Database(f.profile.databasePath, { readonly: true });
      try {
        expect(database.query('SELECT COUNT(*) AS n FROM workspace').get()).toEqual({ n: 0 });
      } finally {
        database.close();
      }
      expect(existsSync(join(f.root, 'models'))).toBe(false);
      expect(readDaemonReservation(f.endpoint)).not.toBeNull();
      expect(assertSharedWorkspace({ fixedWorkspace: f.workspace, cwd: f.root })).toBe(f.workspace);
    } finally {
      await f.cleanup();
    }
    const drift = await remoteFixture(true);
    try {
      await expect(drift.connect()).rejects.toMatchObject({ code: 'shared_connection_failed' });
      expect(existsSync(join(drift.root, 'models'))).toBe(false);
    } finally {
      await drift.cleanup();
    }
  },
);

nativeTest(
  'diagnostic unavailable connection preserves actual metadata without creating a profile or needing runtime assets',
  async () => {
    const f = await fixture(true);
    try {
      const shared = await f.connect();
      expect(shared.bootstrap.dataAvailability).toBe('unavailable');
      expect(shared.bootstrap.storeId).toBeUndefined();
      expect(shared.bootstrap.instanceId).toBe(f.service.bootstrap.instanceId);
      expect(existsSync(f.profile.dataRoot)).toBe(false);
      await expect(shared.client.listAllSessions()).rejects.toMatchObject({
        code: 'data_unavailable',
      });
      expect(f.calls()).toBe(0);
      await shared.close();
      expect(existsSync(f.profile.dataRoot)).toBe(false);
    } finally {
      await f.cleanup();
    }
  },
);

nativeTest(
  'absent and pre-aborted shared selections create no profile or endpoint files',
  async () => {
    const root = realpathSync(mkdtempSync('/private/tmp/kite-shared-absent-'));
    try {
      const profile = selectProfile({ dataRoot: join(root, 'missing'), profile: 'owned' });
      const input = {
        profile,
        server: join(root, 'absent.sock'),
        requiredCapabilities: ['sessions'],
      };
      await expect(connectSharedService(input)).rejects.toMatchObject({
        code: 'shared_bootstrap_failed',
      });
      await expect(
        connectSharedService({ ...input, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: 'shared_connection_aborted' });
      expect(existsSync(profile.dataRoot)).toBe(false);
      expect(existsSync(input.server)).toBe(false);
      expect(existsSync(`${input.server}.lock`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
