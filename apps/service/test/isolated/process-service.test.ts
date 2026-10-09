import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntime } from '@kite-ai/agent';
import { createProfileBackup } from '@kite-ai/agent/maintenance';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import {
  assembleProcessService,
  ProcessServiceCleanupError,
  type ProcessServiceOptions,
} from '../../src/process-service';

for (const unavailable of [false, true])
  test(`common process assembly preserves selected identity and ${unavailable ? 'unavailable diagnostics' : 'cold Store'} without Model calls`, async () => {
    const root = mkdtempSync('/private/tmp/kite-process-assembly-');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const corrupt = 'deliberately not SQLite';
    if (unavailable) {
      mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
      writeFileSync(profile.databasePath, corrupt, { mode: 0o600 });
    }
    let configurations = 0,
      models = 0,
      hooks = 0;
    let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
    const startup = {
      profile: {
        dataRoot: profile.dataRoot,
        profile: profile.profile,
        profileAccessKey: profile.profileAccessKey,
      },
      instanceId: 'assembly',
      buildId: 'fixed',
      token: 'a'.repeat(64),
    };
    let options: ProcessServiceOptions;
    const configure = () => {
      options.beforeResourceClose = async () => {
        throw Error('late_hook_must_not_replace_first');
      };
      configurations++;
      const fixed = createFixedModel([]);
      return {
        modelId: 'fixed',
        model: {
          async *stream(...args: Parameters<typeof fixed.stream>) {
            models++;
            yield* fixed.stream(...args);
          },
        },
      };
    };
    try {
      expect(
        await assembleProcessService(
          { ...startup, profile: { ...startup.profile, profileAccessKey: '0'.repeat(64) } },
          { configure },
        ).catch((error) => error),
      ).toMatchObject({ message: 'profile_identity_mismatch' });
      expect(configurations).toBe(0);
      options = {
        configure,
        async beforeResourceClose() {
          hooks++;
        },
      };
      service = await assembleProcessService(startup, options);
      expect(service.bootstrap).toMatchObject({
        instanceId: 'assembly',
        buildId: 'fixed',
        profile: { dataRoot: profile.dataRoot, name: 'test', accessKey: profile.profileAccessKey },
        dataAvailability: unavailable ? 'unavailable' : 'available',
      });
      const headers = { authorization: `Bearer ${service.bootstrap.token}` };
      const state = await (await fetch(`${service.endpoint}/v1/lifecycle`, { headers })).json();
      expect(state).toMatchObject({
        state: 'accepting',
        busy: false,
        dataAvailability: unavailable ? 'unavailable' : 'available',
      });
      expect((await fetch(`${service.endpoint}/v1/workspaces`, { headers })).status).toBe(
        unavailable ? 503 : 200,
      );
      const first = service.close();
      expect(service.close()).toBe(first);
      await first;
      await service.closedPromise;
      expect(hooks).toBe(1);
      expect(configurations).toBe(1);
      expect(models).toBe(0);
      if (unavailable) expect(readFileSync(profile.databasePath, 'utf8')).toBe(corrupt);
    } finally {
      await service?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const failedCleanup of [false, true])
  test(`failed process HTTP assembly ${failedCleanup ? 'marks actual unconfirmed cleanup and retains profile use' : 'preserves original error after successful cleanup'}`, async () => {
    const root = mkdtempSync('/private/tmp/kite-process-cleanup-');
    const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
    const originalError = Error('fixture_private_initial_error');
    const cleanupError = Error('fixture_private_cleanup_error');
    let runtime: AgentRuntime | undefined;
    let error: unknown;
    try {
      error = await assembleProcessService(
        {
          profile: {
            dataRoot: profile.dataRoot,
            profile: profile.profile,
            profileAccessKey: profile.profileAccessKey,
          },
          instanceId: 'cleanup',
          buildId: 'fixed',
          token: 'a'.repeat(64),
        },
        {
          configure() {
            return {
              modelId: 'fixed',
              model: createFixedModel([]),
              configurationManagement(value) {
                runtime = value!;
                if (failedCleanup) {
                  const begin = runtime.tryBeginShutdown.bind(runtime);
                  runtime.tryBeginShutdown = (mode, options) =>
                    begin(mode, {
                      ...options,
                      async beforeResourceClose() {
                        throw cleanupError;
                      },
                    });
                }
                throw originalError;
              },
            };
          },
        },
      ).catch((error) => error);
      expect(runtime).toBeDefined();
      if (failedCleanup) {
        expect(error).toBeInstanceOf(ProcessServiceCleanupError);
        expect(error).toMatchObject({
          code: 'process_service_cleanup_unconfirmed',
          phase: 'http_assembly',
        });
        expect(JSON.stringify(error)).toBe(
          '{"code":"process_service_cleanup_unconfirmed","phase":"http_assembly"}',
        );
        expect(runtime!.getLifecycleState().state).toBe('drain_failed');
        expect((await runtime!.getMetadata()).storeId).toBeString();
        expect(await runtime!.close().catch((error) => error)).toBe(cleanupError);
        expect(
          await createProfileBackup({ profile, destinationRoot: join(root, 'backup') }).catch(
            (error) => error,
          ),
        ).toMatchObject({ code: 'owner_busy' });
      } else {
        expect(error).toBe(originalError);
        expect(runtime!.getLifecycleState().state).toBe('closed');
        const backup = await createProfileBackup({
          profile,
          destinationRoot: join(root, 'backup'),
        });
        expect(backup.manifest.source.storeId).toBeString();
      }
    } finally {
      if (error instanceof ProcessServiceCleanupError) {
        // Exact owned fixed-model fixture only; production retained these original resources.
        const retained = error.cause as {
          resources: {
            artifacts?: { close(): Promise<void> };
            store?: { close(): Promise<void> };
          };
        };
        await retained.resources.artifacts?.close();
        await retained.resources.store?.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

test('Runtime construction failure closes original SQLite and Artifact owners and preserves its original error', async () => {
  const root = mkdtempSync('/private/tmp/kite-process-construction-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  try {
    const error = await assembleProcessService(
      {
        profile: {
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          profileAccessKey: profile.profileAccessKey,
        },
        instanceId: 'construction',
        buildId: 'fixed',
        token: 'a'.repeat(64),
      },
      {
        configure() {
          return {
            modelId: 'fixed',
            model: createFixedModel([]),
            extensions: [
              { id: 'duplicate', version: '1', apiMajor: 1 },
              { id: 'duplicate', version: '1', apiMajor: 1 },
            ],
          };
        },
      },
    ).catch((error) => error);
    expect(error).toMatchObject({ code: 'extension_definition_conflict' });
    expect(error).not.toBeInstanceOf(ProcessServiceCleanupError);
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
    expect(backup.manifest.source.storeId).toBeString();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite Worker construction failure preserves safe diagnostics and allows maintenance before cold original Store access', async () => {
  const root = mkdtempSync('/private/tmp/kite-process-worker-construction-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  const NativeWorker = globalThis.Worker;
  const originalError = Error('fixture_private_worker_construction_error');
  let attempts = 0,
    models = 0;
  const UnavailableWorker = new Proxy(NativeWorker, {
    construct() {
      attempts++;
      throw originalError;
    },
  });
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let service: Awaited<ReturnType<typeof assembleProcessService>> | undefined;
  try {
    store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///worker-construction-fixture',
      name: 'original workspace',
    });
    await store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'user',
      title: 'original session',
    });
    const originalView = await store.getView('s');
    const metadata = await store.getMetadata();
    await store.close();
    store = undefined;
    const originalBytes = readFileSync(profile.databasePath);
    globalThis.Worker = UnavailableWorker;
    expect(await openSqliteStore(profile).catch((error) => error)).toBe(originalError);
    expect(attempts).toBe(1);

    const fixed = createFixedModel([]);
    service = await assembleProcessService(
      {
        profile: {
          dataRoot: profile.dataRoot,
          profile: profile.profile,
          profileAccessKey: profile.profileAccessKey,
        },
        instanceId: 'worker-construction',
        buildId: 'fixed',
        token: 'a'.repeat(64),
      },
      {
        configure() {
          return {
            modelId: 'fixed',
            model: {
              async *stream(...args: Parameters<typeof fixed.stream>) {
                models++;
                yield* fixed.stream(...args);
              },
            },
          };
        },
      },
    );
    expect(attempts).toBe(2);
    expect(service.bootstrap).toMatchObject({
      instanceId: 'worker-construction',
      buildId: 'fixed',
      profile: { dataRoot: profile.dataRoot, name: 'test', accessKey: profile.profileAccessKey },
      dataAvailability: 'unavailable',
    });
    const headers = { authorization: `Bearer ${service.bootstrap.token}` };
    const lifecycle = await (await fetch(`${service.endpoint}/v1/lifecycle`, { headers })).json();
    expect(lifecycle).toMatchObject({
      state: 'accepting',
      busy: false,
      dataAvailability: 'unavailable',
    });
    expect(JSON.stringify(lifecycle)).not.toContain(originalError.message);
    const response = await fetch(`${service.endpoint}/v1/workspaces`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'data_unavailable' });

    // Real maintenance takes the same Profile EX while diagnostic HTTP is still accepting.
    const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
    expect(backup.manifest.source.storeId).toBe(metadata.storeId);
    expect(readFileSync(profile.databasePath)).toEqual(originalBytes);
    expect(attempts).toBe(2);
    await service.close();
    await service.closedPromise;
    service = undefined;
    globalThis.Worker = NativeWorker;

    store = await openSqliteStore({ ...profile, mode: 'readonly' });
    expect(await store.getMetadata()).toEqual(metadata);
    expect(await store.getView('s')).toEqual(originalView);
    expect(models).toBe(0);
  } finally {
    globalThis.Worker = NativeWorker;
    await service?.close();
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
