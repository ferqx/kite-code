import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import { createProviderModelOwner } from '../../src/app-control/owners/provider-model-owner';

function identity(workspace: string) {
  const project = resolveProjectIdentity(workspace);
  return {
    canonicalPath: workspace,
    projectId: project.projectId,
    workspaceDigest: project.workspaceDigest,
  } as const;
}

describe('Provider/model App Control owner', () => {
  test('projects no-secret routes and applies model selection with revision CAS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-provider-owner-'));
    const workspace = join(root, 'workspace');
    const configPath = join(root, 'config.jsonc');
    mkdirSync(workspace);
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          local: {
            type: 'openai-compatible',
            apiKey: 'must-not-project',
            baseURL: 'https://secret-route.invalid/v1',
            model: 'one',
            models: ['one', 'two'],
          },
        },
        model: 'local:one',
      }),
    );
    const owner = createProviderModelOwner({
      workspace: identity(workspace),
      userConfigPath: configPath,
    });
    const before = await owner.snapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: identity(workspace),
    });
    expect(before.selected).toEqual({ provider: 'local', name: 'one' });
    expect(JSON.stringify(before)).not.toContain('must-not-project');
    expect(JSON.stringify(before)).not.toContain('secret-route');

    const conflict = await owner.select({
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace: identity(workspace),
      provider: 'local',
      name: 'two',
      expectedRevision: `stale-${before.revision}`,
    });
    expect(conflict.outcome).toBe('conflict');

    const selected = await owner.select({
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace: identity(workspace),
      provider: 'local',
      name: 'two',
      expectedRevision: before.revision,
    });
    expect(selected.outcome).toBe('applied');
    expect(selected.snapshot.selected).toEqual({ provider: 'local', name: 'two' });
    expect(selected.snapshot.revision).not.toBe(before.revision);
  });

  test('does not reuse model discovery across owner config identities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-provider-workspaces-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    const firstConfig = join(root, 'first.jsonc');
    const secondConfig = join(root, 'second.jsonc');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(
      firstConfig,
      JSON.stringify({ provider: { first: { type: 'ollama', models: ['first-model'] } } }),
    );
    writeFileSync(
      secondConfig,
      JSON.stringify({ provider: { second: { type: 'ollama', models: ['second-model'] } } }),
    );
    const firstOwner = createProviderModelOwner({
      workspace: identity(first),
      userConfigPath: firstConfig,
    });
    const secondOwner = createProviderModelOwner({
      workspace: identity(second),
      userConfigPath: secondConfig,
    });

    const firstSnapshot = await firstOwner.snapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: identity(first),
    });
    const secondSnapshot = await secondOwner.snapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: identity(second),
    });
    expect(firstSnapshot.providers.map((provider) => provider.provider)).toEqual(['first']);
    expect(secondSnapshot.providers.map((provider) => provider.provider)).toEqual(['second']);
  });
});
