import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertLiveIsolatedTransportSourceDriftV1,
  LIVE_ISOLATED_TRANSPORT_BINDING_V1,
  LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1,
} from '../../../scripts/evals/contracts/qualification/live-isolated-transport-binding-v1';
import { liveIsolatedTransportPromptDigestV1 } from '../../../scripts/evals/qualification/live-isolated-transport-protocol-v1';
import {
  liveIsolatedTransportDeadlineV1,
  type RunLiveIsolatedTransportInputV1,
} from '../../../scripts/evals/qualification/live-isolated-transport-v1';
import { runLiveIsolatedTransportV1 } from '../../../scripts/evals/qualification/live-model-transport-v1';

const FIXTURE = {
  fixtureId: 'qualification-l3-sealed-synthetic-fixture-v1',
  fixtureDigest: `sha256:${'a'.repeat(64)}` as const,
  bytes: new TextEncoder().encode('{"schema":"sealed-synthetic-fixture-v1"}\n'),
};
const CLEANUP_QUARANTINE_PROBE_V1 = fileURLToPath(
  new URL('./fixtures/live-isolated-transport-cleanup-quarantine-probe-v1.ts', import.meta.url),
);
function inputFor(
  phase: 'summary' | 'primary' = 'summary',
  timeoutMs = 1_000,
  operationSignal?: AbortSignal,
): RunLiveIsolatedTransportInputV1 {
  const deadline = liveIsolatedTransportDeadlineV1(timeoutMs);
  if (!deadline) throw new Error('test_deadline_invalid');
  return {
    fixture: FIXTURE,
    request: {
      operation: 'test',
      routeAlias: 'qualification-qwen3.6-flash',
      model: 'qwen3.6-flash',
      phase,
      maxInputTokens: 100,
      maxOutputTokens: 100,
      promptDigest: liveIsolatedTransportPromptDigestV1({ operation: 'test', phase }),
    },
    cutoffAtMs: deadline.cutoffAtMs,
    exitDeadlineAtMs: deadline.exitDeadlineAtMs,
    ...(operationSignal ? { operationSignal } : {}),
  };
}

describe('AQ-8 fixed live isolated transport', () => {
  test('uses an exact child allowlist while leaving the parent cwd and environment unchanged', async () => {
    const cwdBefore = process.cwd();
    const environmentBefore = { ...process.env };
    const terminal = await runLiveIsolatedTransportV1(inputFor(), { testMode: 'return_summary' });

    expect(terminal).toMatchObject({
      status: 'result',
      dispatched: 'known_one',
      exitConfirmed: true,
      result: {
        phase: 'summary',
        outcome: 'success',
        providerDispatchCount: 1,
        generation: { kind: 'accepted_summary' },
      },
    });
    expect(process.cwd()).toBe(cwdBefore);
    expect({ ...process.env }).toEqual(environmentBefore);
    expect(JSON.stringify(terminal)).not.toContain('KITE_QUALIFICATION_QWEN_API_KEY');
  });

  test('keeps every credential-bearing operation safe-disabled before lease or child spawn', async () => {
    const deadline = liveIsolatedTransportDeadlineV1(1_000);
    if (!deadline) throw new Error('test_deadline_invalid');
    let leaseCalls = 0;
    let childSpawns = 0;
    const terminal = await runLiveIsolatedTransportV1(
      {
        fixture: FIXTURE,
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
            leaseCalls += 1;
            throw new Error('disabled_transport_must_not_request_lease');
          },
        },
        request: {
          operation: 'aq8',
          routeAlias: 'qualification-qwen3.6-flash',
          model: 'qwen3.6-flash',
          phase: 'aq8',
          maxInputTokens: 100,
          maxOutputTokens: 100,
          prompt: 'sealed synthetic AQ-8 transport probe',
          promptDigest: liveIsolatedTransportPromptDigestV1({
            operation: 'aq8',
            phase: 'aq8',
            prompt: 'sealed synthetic AQ-8 transport probe',
          }),
        },
        cutoffAtMs: deadline.cutoffAtMs,
        exitDeadlineAtMs: deadline.exitDeadlineAtMs,
        supervisorLedgerRoot: '/not-read-while-supervisor-is-disabled',
      },
      { onChildSpawn: () => (childSpawns += 1) },
    );
    expect(terminal).toEqual({
      status: 'child_failure',
      dispatched: 'known_zero',
      exitConfirmed: true,
    });
    expect(leaseCalls).toBe(0);
    expect(childSpawns).toBe(0);
  });

  test('fails closed on a runtime source-byte drift before a fixed test child can spawn', async () => {
    let childSpawns = 0;
    const terminal = await runLiveIsolatedTransportV1(inputFor(), {
      testMode: 'return_summary',
      forceSourceDriftForTest: true,
      onChildSpawn: () => (childSpawns += 1),
    });
    expect(terminal).toEqual({
      status: 'child_failure',
      dispatched: 'known_zero',
      exitConfirmed: true,
    });
    expect(childSpawns).toBe(0);
  });

  test('cuts off a dispatched hung child inside the full policy budget', async () => {
    const startedAt = Date.now();
    const terminal = await runLiveIsolatedTransportV1(inputFor('summary', 900), {
      testMode: 'hang_after_ready',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(terminal).toEqual({
      status: 'deadline_exceeded',
      dispatched: 'known_one',
      exitConfirmed: true,
    });
    // Exit grace is reserved *inside* the 900ms policy budget. This leaves
    // scheduler headroom without accepting the former second deadline wait.
    expect(elapsedMs).toBeLessThan(1_500);
  });

  test('cuts off an initialization hang before any dispatch', async () => {
    const startedAt = Date.now();
    const terminal = await runLiveIsolatedTransportV1(inputFor('summary', 900), {
      testMode: 'hang_before_ready',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(terminal).toEqual({
      status: 'deadline_exceeded',
      dispatched: 'known_zero',
      exitConfirmed: true,
    });
    expect(elapsedMs).toBeLessThan(1_500);
  });

  test('fails closed for a concurrent child and releases the singleton only after reaping', async () => {
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    const first = runLiveIsolatedTransportV1(inputFor('summary', 900), {
      testMode: 'hang_after_ready',
      onChildSpawn: () => markSpawned?.(),
    });
    try {
      await Promise.race([
        spawned,
        Bun.sleep(1_000).then(() => {
          throw new Error('first_isolated_transport_never_spawned');
        }),
      ]);
      const concurrent = await runLiveIsolatedTransportV1(inputFor(), {
        testMode: 'return_summary',
      });
      expect(concurrent).toEqual({
        status: 'child_failure',
        dispatched: 'known_zero',
        exitConfirmed: true,
      });
      expect(await first).toEqual({
        status: 'deadline_exceeded',
        dispatched: 'known_one',
        exitConfirmed: true,
      });
      expect(
        await runLiveIsolatedTransportV1(inputFor(), { testMode: 'return_summary' }),
      ).toMatchObject({
        status: 'result',
        dispatched: 'known_one',
        exitConfirmed: true,
      });
    } finally {
      await first;
    }
  });

  test('rejects a syntactically valid success that arrives after cancellation', async () => {
    const controller = new AbortController();
    const cwdBefore = process.cwd();
    const environmentBefore = { ...process.env };
    const terminalPromise = runLiveIsolatedTransportV1(
      inputFor('summary', 1_500, controller.signal),
      {
        testMode: 'late_summary_after_cancel',
        onDispatched: () => controller.abort(),
      },
    );
    try {
      const terminal = await terminalPromise;
      expect(terminal).toEqual({
        status: 'child_failure',
        dispatched: 'known_one',
        exitConfirmed: true,
      });
      expect(process.cwd()).toBe(cwdBefore);
      expect({ ...process.env }).toEqual(environmentBefore);
    } finally {
      controller.abort();
      await terminalPromise;
    }
  });

  test('reaps the entire fixed descendant process group before releasing the run', async () => {
    if (process.platform === 'win32') return;
    let leaderPid: number | undefined;
    const terminal = await runLiveIsolatedTransportV1(inputFor('summary', 1_000), {
      testMode: 'spawn_fixed_descendant_then_hang',
      onChildSpawn: (pid) => {
        leaderPid = pid;
      },
    });

    expect(terminal).toEqual({
      status: 'deadline_exceeded',
      dispatched: 'known_one',
      exitConfirmed: true,
    });
    expect(leaderPid).toBeGreaterThan(0);
    let processGroupStillExists = false;
    try {
      process.kill(-leaderPid!, 0);
      processGroupStillExists = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(processGroupStillExists).toBe(false);
  });

  test('quarantines when a fixed leader exits before its descendant, then only test-scrubs after absence and marker proof', async () => {
    let scrubbed: (() => void) | undefined;
    const scrubbedPromise = new Promise<void>((resolve) => {
      scrubbed = resolve;
    });
    const terminal = await runLiveIsolatedTransportV1(inputFor('summary', 1_000), {
      testMode: 'leader_exits_with_descendant_then_exit',
      onQuarantineScrubbed: () => scrubbed?.(),
    });
    expect(terminal).toEqual({
      status: 'child_exit_unconfirmed',
      dispatched: 'unknown',
      exitConfirmed: false,
    });
    // The old leader has exited, so any normal run must fail closed while its
    // fixed descendant is alive; no stale process-group kill is permitted.
    expect(await runLiveIsolatedTransportV1(inputFor(), { testMode: 'return_summary' })).toEqual({
      status: 'child_failure',
      dispatched: 'known_zero',
      exitConfirmed: true,
    });
    await Promise.race([
      scrubbedPromise,
      Bun.sleep(1_500).then(() => {
        throw new Error('leader_exit_quarantine_test_scrub_missing');
      }),
    ]);
    // The closed fixture scrub is test-only. Production unconfirmed exits
    // remain process-lifetime sticky and retain their scratch root.
    expect(
      await runLiveIsolatedTransportV1(inputFor(), { testMode: 'return_summary' }),
    ).toMatchObject({
      status: 'result',
      dispatched: 'known_one',
      exitConfirmed: true,
    });
  });

  test('keeps spawn and setup scratch-cleanup failures sticky without an injectable launcher', async () => {
    for (const mode of [
      'fixed_spawn_failure_with_cleanup_failure',
      'fixed_setup_failure_with_cleanup_failure',
    ] as const) {
      const probe = Bun.spawn(
        [process.execPath, '--no-env-file', CLEANUP_QUARANTINE_PROBE_V1, mode],
        {
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'ignore',
        },
      );
      const output = await new Response(probe.stdout).text();
      expect(await probe.exited).toBe(0);
      expect(output).toBe('isolated_transport_cleanup_quarantine_ok\n');
    }
  });

  test('binds the fixed launcher, protocol, parent boundary, and production child source bytes', () => {
    expect(LIVE_ISOLATED_TRANSPORT_BINDING_V1.launch).toMatchObject({
      executable: 'process.execPath',
      argv: ['--no-env-file', 'live-isolated-transport-child-v1.ts'],
      detached: true,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      windowsProcessTree: 'fail_closed',
      authority: 'fixed_non_exported_launcher_only',
    });
    expect(LIVE_ISOLATED_TRANSPORT_BINDING_V1.protocol.supervisorActivation).toBe(
      'source_literal_disabled_until_persistent_service_authorized',
    );
    expect(LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1).toContain(
      'scripts/evals/qualification/live-scratch-supervisor-health-v1.ts',
    );
    const sources = LIVE_ISOLATED_TRANSPORT_SOURCE_PATHS_V1.map((path) => ({
      path,
      sourceBytes: new Uint8Array(readFileSync(resolve(process.cwd(), path))),
    }));
    expect(() => assertLiveIsolatedTransportSourceDriftV1({ sources })).not.toThrow();
    const mutated = sources.map((source, index) =>
      index === 0
        ? {
            ...source,
            sourceBytes: new TextEncoder().encode(
              `${new TextDecoder().decode(source.sourceBytes)}\n// mutation\n`,
            ),
          }
        : source,
    );
    expect(() => assertLiveIsolatedTransportSourceDriftV1({ sources: mutated })).toThrow(
      'live_isolated_transport_source_drift',
    );
    const launcherSource = readFileSync(
      resolve(process.cwd(), 'scripts/evals/qualification/live-model-transport-v1.ts'),
      'utf8',
    );
    expect(launcherSource).toContain("PATH: '/usr/bin:/bin'");
    expect(launcherSource).toContain("LANG: 'C'");
    expect(launcherSource).toContain("LC_ALL: 'C'");
    expect(launcherSource).toContain("TZ: 'UTC'");
    expect(launcherSource).not.toContain('tmpdir(');
    expect(launcherSource).not.toContain('parentEnvironment');
    expect(launcherSource).not.toContain('runLiveIsolatedTransportWithSpawnerV1');
    expect(launcherSource).not.toContain('LiveIsolatedTransportChildSpawnerV1');
    expect(launcherSource).not.toContain('export function spawnFixedLiveIsolatedChildV1');
    expect(launcherSource).toContain('trustedScratchParentV1');
  });
});
