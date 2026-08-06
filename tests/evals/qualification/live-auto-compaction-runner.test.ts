import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertL3LiveAutoCompactionProductGraphV1 } from '../../../scripts/evals/contracts/qualification/live-auto-compaction-graph-contract-v1';
import {
  assertL3LiveAutoCompactionRunnerSourceDriftV1,
  L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/live-auto-compaction-policy-v1';
import {
  isL3LiveAutoCompactionRequestBoundToTurnV1,
  runL3LiveAutoCompactionV1,
  runL3LiveAutoCompactionWithDependenciesV1,
  runSyntheticAutoCompactionContractV1,
} from '../../../scripts/evals/qualification/run-l3-live-auto-compaction';
import { installFreshLiveScratchSupervisorHealthV1 } from './fixtures/live-scratch-supervisor-health';

const NOW = '2026-08-06T00:00:00.000Z';

function withLedgerRoot(testBody: (ledgerRoot: string) => Promise<void>): Promise<void> {
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'kite-live-auto-compaction-runner-'));
  return testBody(ledgerRoot).finally(() => rmSync(ledgerRoot, { recursive: true, force: true }));
}

function throwingEnvironment(): Readonly<Record<string, string | undefined>> {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('public_aq9b_runner_must_not_read_parent_environment_while_disabled');
      },
      ownKeys() {
        throw new Error('public_aq9b_runner_must_not_enumerate_parent_environment_while_disabled');
      },
    },
  ) as Readonly<Record<string, string | undefined>>;
}

describe('AQ-9B public availability boundary and synthetic product contract', () => {
  test('keeps public AQ-9B safe-disabled before resolver, reservation, local model adapter, or child dispatch', async () => {
    await withLedgerRoot(async (ledgerRoot) => {
      installFreshLiveScratchSupervisorHealthV1(ledgerRoot, Date.parse(NOW));
      const entriesBefore = readdirSync(ledgerRoot).sort();
      const report = await runL3LiveAutoCompactionWithDependenciesV1(
        {
          explicitOptIn: true,
          parentEnvironment: throwingEnvironment(),
          ledgerRoot,
        },
        {
          now: () => new Date(NOW),
        },
      );
      expect(report).toMatchObject({
        authority: 'diagnostic',
        evidenceEligible: false,
        status: 'blocked',
        reasonCode: 'governance_reservation_unavailable',
        providerDispatchCount: 0,
      });
      expect(readdirSync(ledgerRoot).sort()).toEqual(entriesBefore);
    });
  });

  test('fails closed on fixed-path runner-byte drift before reading parent environment or ledger', async () => {
    await withLedgerRoot(async (ledgerRoot) => {
      const entriesBefore = readdirSync(ledgerRoot).sort();
      const report = await runL3LiveAutoCompactionWithDependenciesV1(
        {
          explicitOptIn: true,
          parentEnvironment: throwingEnvironment(),
          ledgerRoot,
        },
        {
          now: () => new Date(NOW),
          forceRunnerSourceDriftForTest: true,
        },
      );
      expect(report).toMatchObject({
        status: 'blocked',
        reasonCode: 'policy_invalid',
        providerDispatchCount: 0,
      });
      expect(readdirSync(ledgerRoot).sort()).toEqual(entriesBefore);
    });
  });

  test('runs the literal product chain only in a zero-credential synthetic test driver', async () => {
    const effects: string[] = [];
    const result = await runSyntheticAutoCompactionContractV1({
      scenario: 'success',
      onPermittedProductEffect: (effectType) => effects.push(effectType),
    });
    expect(effects).toEqual(['call_model', 'compact_context', 'call_model']);
    expect(result).toEqual({
      schema: 'SyntheticAutoCompactionContractResultV1',
      version: 1,
      testOnly: true,
      persistence: 'forbidden',
      status: 'success',
      reasonCode: 'synthetic_success',
      summaryPhaseState: 'dispatched_known',
      primaryPhaseState: 'dispatched_known',
      providerDispatchCount: 2,
      nextTurnPreflight: false,
    });
    const serialized = JSON.stringify(result);
    for (const prohibited of ['recordDigest', 'reportDigest', 'observation', 'receipt', 'ledger']) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  test('keeps cancellation in the synthetic child boundary: four product effects, one isolated dispatch, next-turn preflight', async () => {
    const controller = new AbortController();
    const effects: string[] = [];
    let isolatedDispatches = 0;
    let nextTurnId: string | undefined;
    const result = await runSyntheticAutoCompactionContractV1({
      signal: controller.signal,
      isolatedTransportTestModes: ['late_result'],
      onIsolatedTransportDispatch: () => {
        isolatedDispatches += 1;
        controller.abort();
      },
      onPermittedProductEffect: (effectType) => effects.push(effectType),
      onCancellationNextTurnPreflight: (turnId) => {
        nextTurnId = turnId;
        // The fourth effect is the next user turn's scheduler-verified
        // ModelController preflight. It is intentionally not a second child
        // dispatch under the cancelled turn's operation signal.
        effects.push('call_model');
      },
    });
    expect(effects).toEqual(['call_model', 'compact_context', 'call_model', 'call_model']);
    expect(isolatedDispatches).toBe(1);
    expect(nextTurnId).toBe('qualification-l3-live-auto-compaction-next-turn-v1');
    expect(result).toMatchObject({
      schema: 'SyntheticAutoCompactionContractResultV1',
      testOnly: true,
      persistence: 'forbidden',
      status: 'cancelled',
      reasonCode: 'synthetic_cancelled',
      summaryPhaseState: 'dispatched_known',
      primaryPhaseState: 'known_zero',
      providerDispatchCount: 1,
      nextTurnPreflight: true,
    });
  });

  test('rejects a mutated automatic-compaction turn binding', () => {
    const event = {
      type: 'context.compaction_requested' as const,
      compactionId: 'qualification-auto-compaction-request-v1',
      reason: 'auto' as const,
      requestedAtRevision: 1,
      requestedAtTurnId: 'qualification-turn-v1',
      force: false,
      estimate: {
        totalInputTokens: 9_000,
        transcriptTokens: 9_000,
        systemTokens: 0,
        toolSchemaTokens: 0,
        summaryTokens: 0,
        dynamicRuntimeTokens: 0,
        framingTokens: 0,
      },
    };
    expect(isL3LiveAutoCompactionRequestBoundToTurnV1(event, 'qualification-turn-v1')).toBe(true);
    expect(
      isL3LiveAutoCompactionRequestBoundToTurnV1(
        { ...event, requestedAtTurnId: 'mutated-different-turn-v1' },
        'qualification-turn-v1',
      ),
    ).toBe(false);
  });

  test('keeps the public entrypoint default-off and source-bound', async () => {
    const source = readFileSync(
      new URL(
        '../../../scripts/evals/qualification/run-l3-live-auto-compaction.ts',
        import.meta.url,
      ),
      'utf8',
    );
    for (const forbidden of [
      'process.env',
      'loadAgentConfig',
      'loadProductionAgentConfig',
      'runRuntimeAgent',
      'spawn(',
      'exec(',
      'ReleaseEvidenceV1',
      'gate-evaluator',
      'console.log',
      'console.error',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    assertL3LiveAutoCompactionRunnerSourceDriftV1({
      runnerId: L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
      sourceBytes: new TextEncoder().encode(source),
    });
    const syntheticInputSource = source.slice(
      source.indexOf('export interface SyntheticAutoCompactionContractInputV1'),
      source.indexOf('export interface SyntheticAutoCompactionContractResultV1'),
    );
    expect(syntheticInputSource).toContain("readonly scenario?: 'success';");
    expect(syntheticInputSource).not.toContain('testModel');
    expect(syntheticInputSource).not.toContain('parentEnvironment');
    expect(syntheticInputSource).not.toContain('ledgerRoot');
    expect(syntheticInputSource).not.toContain('modelBoundary');
    const blocked = await runL3LiveAutoCompactionV1({
      explicitOptIn: false,
      parentEnvironment: throwingEnvironment(),
      ledgerRoot: undefined,
    });
    expect(blocked).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'blocked',
      reasonCode: 'explicit_opt_in_required',
      providerDispatchCount: 0,
    });
  });

  test('keeps synthetic contract-only APIs unreachable from package/CLI/live wrappers and public graph outside release evaluation', async () => {
    const syntheticApi = 'runSyntheticAutoCompactionContractV1';
    for (const path of [
      'package.json',
      'src/app/cli/index.ts',
      'tests/e2e/live/model/auto-compaction-success.live.ts',
      'tests/e2e/live/model/auto-compaction-cancel.live.ts',
    ]) {
      expect(readFileSync(resolve(process.cwd(), path), 'utf8')).not.toContain(syntheticApi);
    }
    const productionSources = new Set<string>();
    for (const pattern of ['src/**/*.ts', 'scripts/**/*.ts', 'release/qualification/**/*.ts']) {
      for await (const path of new Bun.Glob(pattern).scan({ cwd: process.cwd() })) {
        productionSources.add(path);
      }
    }
    for (const path of productionSources) {
      if (path === 'scripts/evals/qualification/run-l3-live-auto-compaction.ts') continue;
      expect(readFileSync(resolve(process.cwd(), path), 'utf8')).not.toContain(syntheticApi);
    }
    const entrypoint = resolve(
      process.cwd(),
      'scripts/evals/qualification/run-l3-live-auto-compaction.ts',
    );
    const build = await Bun.build({
      entrypoints: [entrypoint],
      format: 'esm',
      metafile: true,
      target: 'bun',
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {}).map((entry) =>
      entry.replaceAll('\\', '/'),
    );
    const runnerInput = Object.entries(build.metafile?.inputs ?? {}).find(([entry]) =>
      entry
        .replaceAll('\\', '/')
        .endsWith('scripts/evals/qualification/run-l3-live-auto-compaction.ts'),
    )?.[1];
    if (!runnerInput) throw new Error('l3_live_auto_compaction_runner_metafile_missing');
    assertL3LiveAutoCompactionProductGraphV1({
      inputs,
      directRunnerImports: runnerInput.imports.map((entry) => entry.path.replaceAll('\\', '/')),
    });
    for (const requiredInput of [
      'scripts/evals/contracts/qualification/live-isolated-transport-binding-v1.ts',
      'scripts/evals/qualification/live-model-transport-v1.ts',
      'scripts/evals/qualification/live-isolated-transport-v1.ts',
      'scripts/evals/qualification/live-isolated-transport-protocol-v1.ts',
      'scripts/evals/qualification/live-scratch-supervisor-health-v1.ts',
    ]) {
      expect(inputs.some((entry) => entry.endsWith(requiredInput))).toBe(true);
    }
  });
});
