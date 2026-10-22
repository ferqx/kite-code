import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import { seedLegacyProcessing } from '../../../../packages/agent/test/isolated/recovery/human-input-processing-crash-fixture';
import { temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

test('actual Service reads old processing history and rejects its resume before loading the current model configuration', async () => {
  const root = temporaryDirectory('kite-service-retired-input-');
  const f = await seedLegacyProcessing(root);
  const profile = selectProfile(f.profile);
  const config = join(root, 'user.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      modelId: 'current-B',
      tools: [],
      models: [
        {
          id: 'current-B',
          provider: 'compatible',
          model: 'current-B',
          baseURL: 'http://127.0.0.1:1/v1',
        },
      ],
    }),
  );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: config,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        throw Error('no_credentials');
      },
      async remove() {
        throw Error('no_credentials');
      },
      async resolve() {
        throw Error('must_not_load_model');
      },
    },
  });
  const runtime = createRuntime({ ...host, store: f.store, permissions: host.permissions! });
  host.permissionManagement?.(runtime);
  const service = await startService({
    runtime,
    subjectId: 'owner',
    buildId: 'retired-input-test',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'run_resume'],
    },
  });
  try {
    await client.connect();
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await client.getView('s')).runs[0]?.id).toBe(f.run!.id);
    expect((await client.getCommand(f.processing.id)).status).toBe('applied');
    expect((await f.store.getCommand(f.processing.id))?.request).toMatchObject({
      content: 'Old ambiguous input',
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const rejected = await client
      .resumeRun('s', {
        kind: 'run.resume',
        expectedStoreId: f.scope.expectedStoreId,
        commandId: 'resume',
        runId: f.run!.id,
      })
      .catch((error) => error);
    expect(rejected.code).toBe('input_processing_removed');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getCommand(f.raw.id)).toEqual(f.raw);
    expect((await f.store.getExecution('legacy-model'))?.status).toBe('planned');
  } finally {
    client.disposeNetwork();
    await service.close();
    await f.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
