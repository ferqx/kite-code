import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  invokeSealedLiveModelV1,
  invokeSealedLiveModelWithDependenciesV1,
} from '../../../scripts/evals/qualification/live-model-transport-v1';

const FIXTURE = {
  fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
  fixtureDigest: `sha256:${'a'.repeat(64)}` as const,
  bytes: new TextEncoder().encode('{"schema":"sealed-synthetic-fixture-v1"}\n'),
};

describe('AQ-8 direct sealed model transport', () => {
  test('rejects an invalid sealed request before a model-boundary lease can dispatch', async () => {
    let leaseUsed = false;
    const result = await invokeSealedLiveModelV1({
      modelBoundary: {
        route: {
          routeAlias: 'qualification-qwen3.6-flash',
          model: 'qwen3.6-flash',
          protocolFamily: 'openai_compatible',
          routeIdentityDigest: `sha256:${'a'.repeat(64)}`,
          providerDataPolicyDigest: `sha256:${'b'.repeat(64)}`,
          promptEnvironmentDigest: `sha256:${'c'.repeat(64)}`,
          toolCatalogDigest: `sha256:${'d'.repeat(64)}`,
          capabilityDeclarationDigest: `sha256:${'e'.repeat(64)}`,
        },
        credentialSource: 'environment',
        withModelTransport: () => {
          leaseUsed = true;
          throw new Error('model-boundary-must-not-run');
        },
      },
      prompt: '',
      maxInputTokens: 12_288,
      maxOutputTokens: 600,
      timeoutMs: 600_000,
      fixture: FIXTURE,
    });
    expect(leaseUsed).toBe(false);
    expect(result).toEqual({
      outcome: 'not_observed',
      providerDispatchCount: 0,
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    });
  });

  test('maps a fixed dispatched cancellation without exposing a provider lease', async () => {
    let leaseUsed = false;
    const detailed = await invokeSealedLiveModelWithDependenciesV1(
      {
        modelBoundary: {
          route: {
            routeAlias: 'qualification-qwen3.6-flash',
            model: 'qwen3.6-flash',
            protocolFamily: 'openai_compatible',
            routeIdentityDigest: `sha256:${'a'.repeat(64)}`,
            providerDataPolicyDigest: `sha256:${'b'.repeat(64)}`,
            promptEnvironmentDigest: `sha256:${'c'.repeat(64)}`,
            toolCatalogDigest: `sha256:${'d'.repeat(64)}`,
            capabilityDeclarationDigest: `sha256:${'e'.repeat(64)}`,
          },
          credentialSource: 'environment',
          withModelTransport: () => {
            leaseUsed = true;
            throw new Error('fixed test mode must not request a provider lease');
          },
        },
        prompt: 'synthetic AQ-8 prompt only',
        maxInputTokens: 100,
        maxOutputTokens: 100,
        timeoutMs: 1_000,
        fixture: FIXTURE,
      },
      { testMode: 'return_cancelled' },
    );

    expect(leaseUsed).toBe(false);
    expect(detailed).toMatchObject({
      outcome: 'cancelled',
      providerDispatchCount: 1,
      terminal: {
        status: 'result',
        dispatched: 'known_one',
        exitConfirmed: true,
        result: { outcome: 'cancelled', providerDispatchCount: 1 },
      },
    });
    expect(JSON.stringify(detailed)).not.toContain('transport-test-credential-never-output');
  });

  test('uses a child-only diagnostic zero-retry path and contains no product runtime/config shortcut', () => {
    const parentSource = readFileSync(
      new URL('../../../scripts/evals/qualification/live-model-transport-v1.ts', import.meta.url),
      'utf8',
    );
    const childSource = readFileSync(
      new URL(
        '../../../scripts/evals/qualification/live-isolated-transport-child-v1.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(parentSource).toContain("[process.execPath, '--no-env-file', entrypoint]");
    expect(parentSource).not.toContain('runLiveIsolatedTransportWithSpawnerV1');
    expect(parentSource).not.toContain('LiveIsolatedTransportChildSpawnerV1');
    expect(parentSource).not.toContain('parentEnvironment');
    expect(parentSource).not.toContain('tmpdir(');
    expect(parentSource).not.toContain('export function spawnFixedLiveIsolatedChildV1');
    expect(parentSource).toContain("PATH: '/usr/bin:/bin'");
    expect(parentSource).toContain("LANG: 'C'");
    expect(parentSource).toContain("LC_ALL: 'C'");
    expect(parentSource).toContain("TZ: 'UTC'");
    expect(childSource).toContain('maxRetries: 0');
    expect(childSource).not.toContain('Bun.spawn');
    for (const forbidden of [
      'createChatModel',
      'loadAgentConfig',
      'loadProductionAgentConfig',
      'runRuntimeAgent',
      'ReleaseEvidenceV1',
      'gate-evaluator',
      'console.log',
      'console.error',
    ]) {
      expect(parentSource).not.toContain(forbidden);
      expect(childSource).not.toContain(forbidden);
    }
  });
});
