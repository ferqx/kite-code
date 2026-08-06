import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertLiveSuiteRunnerSourceDriftV1,
  L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
  L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
} from '../../../scripts/evals/contracts/qualification/live-route-resolver-v1';
import {
  runL3LiveCompatibilityV1,
  runL3LiveCompatibilityWithDependenciesV1,
} from '../../../scripts/evals/qualification/run-l3-live-compatibility';
import { installFreshLiveScratchSupervisorHealthV1 } from './fixtures/live-scratch-supervisor-health';

const NOW = new Date().toISOString();
const CREDENTIAL_SENTINEL = 'l3-runner-credential-sentinel-never-output';

function withLedgerRoot(testBody: (ledgerRoot: string) => Promise<void>): Promise<void> {
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'kite-live-compatibility-runner-'));
  return testBody(ledgerRoot).finally(() => rmSync(ledgerRoot, { recursive: true, force: true }));
}

function throwingEnvironment(): Readonly<Record<string, string | undefined>> {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('public_l3_runner_must_not_read_parent_environment_while_disabled');
      },
      ownKeys() {
        throw new Error('public_l3_runner_must_not_enumerate_parent_environment_while_disabled');
      },
    },
  ) as Readonly<Record<string, string | undefined>>;
}

describe('AQ-8 public L3 compatibility runner availability boundary', () => {
  test('is safe-disabled before resolver, ledger reservation, model lease, or mock dispatch', async () => {
    await withLedgerRoot(async (ledgerRoot) => {
      // A valid-looking local record is deliberately insufficient: a writable
      // ledger root can never be the authority that enables a live transport.
      installFreshLiveScratchSupervisorHealthV1(ledgerRoot, Date.parse(NOW));
      const entriesBefore = readdirSync(ledgerRoot).sort();
      const report = await runL3LiveCompatibilityWithDependenciesV1(
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
      expect(JSON.stringify(report)).not.toContain(CREDENTIAL_SENTINEL);
    });
  });

  test('fails closed on a fixed-path runner-byte drift before reading environment or ledger', async () => {
    await withLedgerRoot(async (ledgerRoot) => {
      const entriesBefore = readdirSync(ledgerRoot).sort();
      const report = await runL3LiveCompatibilityWithDependenciesV1(
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

  test('keeps the public entrypoint default-off and produces no live conclusion', async () => {
    const report = await runL3LiveCompatibilityV1({
      explicitOptIn: false,
      parentEnvironment: throwingEnvironment(),
      ledgerRoot: undefined,
    });
    expect(report).toMatchObject({
      authority: 'diagnostic',
      evidenceEligible: false,
      status: 'blocked',
      reasonCode: 'explicit_opt_in_required',
      providerDispatchCount: 0,
    });
    expect(report.outcome).toBeUndefined();
    expect(report.observationRecordDigest).toBeUndefined();
  });

  test('keeps the public source fixed-byte-bound, diagnostic-only, and free of release/Gate wiring', () => {
    const source = readFileSync(
      new URL('../../../scripts/evals/qualification/run-l3-live-compatibility.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'process.env',
      'loadAgentConfig',
      'loadProductionAgentConfig',
      'createChatModel',
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
    assertLiveSuiteRunnerSourceDriftV1({
      policy: L3_LIVE_COMPATIBILITY_SUITE_POLICY_V1,
      fixture: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1,
      runnerId: L3_LIVE_COMPATIBILITY_FIXTURE_DECLARATION_V1.runnerId,
      sourceBytes: new TextEncoder().encode(source),
    });
  });

  test('keeps its transitive graph outside release evaluation and includes the supervisor guard closure', async () => {
    const build = await Bun.build({
      entrypoints: [
        resolve(process.cwd(), 'scripts/evals/qualification/run-l3-live-compatibility.ts'),
      ],
      format: 'esm',
      metafile: true,
      target: 'bun',
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {}).map((entry) =>
      entry.replaceAll('\\', '/'),
    );
    for (const forbiddenInput of [
      'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts',
      'scripts/evals/contracts/qualification/evidence/evidence-schema-v1.ts',
      'release/qualification/source-owned-surface-v1.ts',
      'scripts/release/evidence-schema.ts',
      'scripts/release/evidence-bundle.ts',
      'scripts/release/gate-evaluator.ts',
      'scripts/release/gate-replay.ts',
      'scripts/release/foundation-gate.ts',
      'scripts/release/capability-maturity-gate.ts',
    ]) {
      expect(
        inputs.some((entry) => entry.endsWith(forbiddenInput) || entry.includes(forbiddenInput)),
      ).toBe(false);
    }
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
