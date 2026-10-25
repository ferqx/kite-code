import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import {
  createConfigurationSnapshot,
  createCredentialVault,
  createTemporaryCredentialBackend,
  type JsonObject,
  resolveConfiguration,
} from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient } from '@kite-ai/client';
import { createConfigurationManagement } from '../../src/configuration-management';
import { schemas } from '../../src/http/schema';
import { startService } from '../../src/index';
import { createUserConfiguration } from '../../src/user-configuration';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-model-continuation-'));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    file,
    '// retain private bytes\n' +
      JSON.stringify({
        provider: {
          service: {
            type: 'compatible',
            baseURL: 'http://127.0.0.1:1234/v1',
            models: ['remote-a', 'remote-b'],
          },
        },
        model: 'service:remote-a',
        disabledModels: ['service:remote-b'],
        privateOther: 'DO_NOT_PROJECT',
      }) +
      '\n',
    { mode: 0o600 },
  );
  let capacity = 10000;
  const source = createUserConfiguration(file, {
    discover: () => ({
      alias: 'codex-owned-proof',
      name: 'Local',
      models: [{ name: 'actual-local', contextWindowTokens: capacity }],
      defaultModel: 'actual-local',
    }),
  });
  let afterPublication: (() => void) | undefined;
  let skipCandidate = false;
  let candidateDigest: string | undefined;
  const explicit: JsonObject = {};
  const runtime = createRuntime({
    store: await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile }),
    permissions: { authorize: async () => ({ allowed: false, revision: 'proof-no-execution' }) },
  });
  const manager = createConfigurationManagement({
    profile,
    runtime,
    vault: createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    persistence: 'temporary',
    explicit: () => explicit,
    userConfiguration: {
      ...source,
      update(input) {
        const result = source.update(
          skipCandidate ? { ...input, validateCandidate: undefined } : input,
        );
        candidateDigest = createConfigurationSnapshot(
          resolveConfiguration({
            defaults: { modelId: null, models: [], tools: [], skills: [], mcp: [] },
            user: result.value,
            explicit,
          }),
        ).digest;
        afterPublication?.();
        return result;
      },
    },
  });
  const service = await startService({
    runtime,
    configurationManagement: manager,
    buildId: 'model-continuation-test',
    subjectId: 'proof-owner',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management'],
    },
  });
  await client.connect();
  const storeId = (await runtime.getMetadata()).storeId;
  return {
    client,
    manager,
    file,
    storeId,
    get candidateDigest() {
      return candidateDigest;
    },
    changeDynamicAfterPublication() {
      afterPublication = () => {
        capacity = 20000;
      };
    },
    omitCandidateCallback() {
      skipCandidate = true;
    },
    async close() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('applied model mutation publishes its exact candidate successor read set through HTTP and original-ID lookup', async () => {
  const f = await fixture();
  try {
    const before = await f.client.getModelSettings('user', { storeId: f.storeId });
    const model = before.models.find((entry) => entry.model === 'remote-b')!;
    const intent = {
      commandId: 'enable-owned',
      expectedStoreId: f.storeId,
      expectedReadSet: before.readSet!,
      operation: { kind: 'enabled' as const, modelId: model.id, enabled: true },
    };
    const applied = await f.client.updateModelSettings('user', intent);
    const after = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(applied.state).toBe('applied');
    expect(applied.receipt).toEqual({
      status: 'applied',
      etag: after.readSet!.userEtag,
      postReadSet: after.readSet!,
    });
    expect(after.readSet!.effectiveDigest).toBe(f.candidateDigest!);
    expect(applied.modelSettings).toEqual({
      expectedReadSet: before.readSet!,
      operation: intent.operation,
    });
    expect(after.models.find((entry) => entry.id === model.id)?.enabled).toBe(true);
    expect(readFileSync(f.file, 'utf8')).toContain('// retain private bytes');
    expect(JSON.stringify(applied)).not.toContain('DO_NOT_PROJECT');
    expect(JSON.stringify(applied)).not.toContain(f.file);
    expect(await f.client.getHostMutation(intent.commandId, { storeId: f.storeId })).toEqual(
      applied,
    );
    const originalBytes = readFileSync(f.file, 'utf8');
    writeFileSync(f.file, `${originalBytes}// external edit after this receipt\n`);
    expect(await f.client.updateModelSettings('user', intent)).toEqual(applied);
    expect(readFileSync(f.file, 'utf8')).toBe(
      `${originalBytes}// external edit after this receipt\n`,
    );
    for (const kind of ['config.patch', 'provider_settings.update', 'credential.put'] as const) {
      expect(schemas.HostMutation.safeParse({ ...applied, kind }).success).toBe(false);
    }
    expect(schemas.HostMutation.safeParse({ ...applied, state: 'failed' }).success).toBe(false);
    expect(
      schemas.HostMutation.safeParse({
        ...applied,
        receipt: { status: 'applied', etag: after.readSet!.userEtag },
      }).success,
    ).toBe(true);
    expect(
      schemas.HostMutation.safeParse({
        ...applied,
        receipt: {
          status: 'applied',
          etag: after.readSet!.userEtag,
          postReadSet: { ...after.readSet, secret: 'forged' },
        },
      }).success,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test('successor effectiveDigest is the validated candidate even when dynamic local source changes immediately after publication', async () => {
  const f = await fixture();
  try {
    const before = await f.client.getModelSettings('user', { storeId: f.storeId });
    f.changeDynamicAfterPublication();
    const applied = await f.client.updateModelSettings('user', {
      commandId: 'dynamic-source',
      expectedStoreId: f.storeId,
      expectedReadSet: before.readSet!,
      operation: {
        kind: 'enabled',
        modelId: before.models.find((entry) => entry.model === 'remote-b')!.id,
        enabled: true,
      },
    });
    const after = await f.client.getModelSettings('user', { storeId: f.storeId });
    const proof = 'postReadSet' in applied.receipt ? applied.receipt.postReadSet : undefined;
    expect(proof).toEqual({
      userEtag: after.readSet!.userEtag,
      workspaceEtag: null,
      explicitDigest: before.readSet!.explicitDigest,
      effectiveDigest: f.candidateDigest!,
    });
    expect(after.readSet!.userEtag).not.toBe(before.readSet!.userEtag);
    expect(after.readSet!.explicitDigest).toBe(before.readSet!.explicitDigest);
    expect(after.readSet!.effectiveDigest).not.toBe(f.candidateDigest!);
    expect(await f.client.getHostMutation('dynamic-source', { storeId: f.storeId })).toEqual(
      applied,
    );
  } finally {
    await f.close();
  }
});

test('absent candidate evidence does not turn an applied write into failure and a rejected write never gains successor proof', async () => {
  const f = await fixture();
  try {
    const before = await f.client.getModelSettings('user', { storeId: f.storeId });
    f.omitCandidateCallback();
    const applied = await f.client.updateModelSettings('user', {
      commandId: 'legacy-no-proof',
      expectedStoreId: f.storeId,
      expectedReadSet: before.readSet!,
      operation: {
        kind: 'enabled',
        modelId: before.models.find((entry) => entry.model === 'remote-b')!.id,
        enabled: true,
      },
    });
    expect(applied.state).toBe('applied');
    expect(applied.receipt).not.toHaveProperty('postReadSet');
    const current = await f.client.getModelSettings('user', { storeId: f.storeId });
    const rejected = await f.client
      .updateModelSettings('user', {
        commandId: 'rejected-missing-model',
        expectedStoreId: f.storeId,
        expectedReadSet: current.readSet!,
        operation: { kind: 'default', modelId: 'missing-route' },
      })
      .catch((error: unknown) => error);
    expect((rejected as { code?: string }).code).toBe('model_settings_model_missing');
    const saved = await f.client.getHostMutation('rejected-missing-model', {
      storeId: f.storeId,
    });
    expect(saved.state).toBe('failed');
    expect(saved.receipt).toEqual({
      status: 'failed',
      code: 'model_settings_model_missing',
    });
  } finally {
    await f.close();
  }
});
