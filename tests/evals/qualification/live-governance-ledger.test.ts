import { describe, expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLiveGovernanceLedgerTestHarnessV1,
  isLiveGovernanceLedgerRecordV1,
  isLiveGovernanceLedgerTerminalEventV1,
  LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1,
  reserveLiveGovernanceQuotaV1,
} from '../../../scripts/evals/qualification/live-governance-ledger-v1';

const NOW = '2026-08-06T00:00:00.000Z';
const LATER = '2026-08-06T00:00:02.000Z';
const POLICY_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const OTHER_POLICY_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const REQUESTED = {
  attempts: 1,
  tokens: 100,
  runWallClockSeconds: 10,
  costUsdMicros: 100,
} as const;

const reservationIdsByLedgerRoot = new Map<string, Map<string, string>>();

function withLedger<T>(callback: (ledgerRoot: string) => T): T {
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'kite-live-governance-ledger-'));
  reservationIdsByLedgerRoot.set(ledgerRoot, new Map());
  try {
    return callback(ledgerRoot);
  } finally {
    reservationIdsByLedgerRoot.delete(ledgerRoot);
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
}

async function withLedgerAsync<T>(callback: (ledgerRoot: string) => Promise<T>): Promise<T> {
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'kite-live-governance-ledger-'));
  reservationIdsByLedgerRoot.set(ledgerRoot, new Map());
  try {
    return await callback(ledgerRoot);
  } finally {
    reservationIdsByLedgerRoot.delete(ledgerRoot);
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
}

function reservationIdFor(ledgerRoot: string, label: string): string {
  const reservationId = reservationIdsByLedgerRoot.get(ledgerRoot)?.get(label);
  if (!reservationId) throw new Error('missing_test_reservation_id');
  return reservationId;
}

function testHarnessAt(now: unknown) {
  return createLiveGovernanceLedgerTestHarnessV1({ now: () => new Date(String(now)) });
}

function reserve(ledgerRoot: string, label: string, overrides: Record<string, unknown> = {}) {
  const { now = NOW, ...reservationOverrides } = overrides;
  const result = testHarnessAt(now).reserve({
    ledgerRoot,
    routePolicyDigest: POLICY_DIGEST,
    requested: REQUESTED,
    ...reservationOverrides,
  } as Parameters<ReturnType<typeof testHarnessAt>['reserve']>[0]);
  if (result.status === 'reserved') {
    reservationIdsByLedgerRoot.get(ledgerRoot)?.set(label, result.reservation.reservationId);
  }
  return result;
}

function reconcile(ledgerRoot: string, label: string, overrides: Record<string, unknown> = {}) {
  const { now = NOW, ...reconciliationOverrides } = overrides;
  return testHarnessAt(now).reconcile({
    ledgerRoot,
    reservationId: reservationIdFor(ledgerRoot, label),
    routePolicyDigest: POLICY_DIGEST,
    actual: REQUESTED,
    ...reconciliationOverrides,
  } as Parameters<ReturnType<typeof testHarnessAt>['reconcile']>[0]);
}

function readRecord(
  ledgerRoot: string,
  label: string,
  kind: 'reservation' | 'terminal' = 'reservation',
): unknown {
  const reservationId = reservationIdFor(ledgerRoot, label);
  return JSON.parse(
    readFileSync(join(ledgerRoot, 'records', `${reservationId}.${kind}.json`), 'utf8'),
  );
}

describe('AQ-8 owner-only live governance ledger', () => {
  test('reserves before dispatch, reconciles within its reservation, and enforces day quota', () => {
    withLedger((ledgerRoot) => {
      const first = reserve(ledgerRoot, 'reservation-one');
      expect(first.status).toBe('reserved');
      if (first.status !== 'reserved') throw new Error('expected_reservation');
      const firstReservationId = first.reservation.reservationId;
      expect(first.reservation).toMatchObject({
        authority: 'diagnostic',
        evidenceEligible: false,
        reservationId: firstReservationId,
        routePolicyDigest: POLICY_DIGEST,
        dayQuotaLedger: { status: 'reserved', reserved: REQUESTED },
        monthQuotaLedger: { status: 'reserved', reserved: REQUESTED },
      });
      const immutableReservationBytes = readFileSync(
        join(ledgerRoot, 'records', `${firstReservationId}.reservation.json`),
        'utf8',
      );

      const reconciled = reconcile(ledgerRoot, 'reservation-one');
      expect(reconciled.status).toBe('reconciled');
      if (reconciled.status !== 'reconciled') throw new Error('expected_reconciliation');
      expect(reconciled.reservation.dayQuotaLedger).toMatchObject({
        status: 'reconciled',
        reserved: REQUESTED,
        reconciled: REQUESTED,
      });
      expect(
        readFileSync(join(ledgerRoot, 'records', `${firstReservationId}.reservation.json`), 'utf8'),
      ).toBe(immutableReservationBytes);
      expect(
        isLiveGovernanceLedgerTerminalEventV1(
          readRecord(ledgerRoot, 'reservation-one', 'terminal'),
        ),
      ).toBe(true);

      for (const reservationId of ['reservation-two', 'reservation-three', 'reservation-four']) {
        const result = reserve(ledgerRoot, reservationId, {
          requested: {
            attempts: 2,
            tokens: 8_000,
            runWallClockSeconds: 400,
            costUsdMicros: 160_000,
          },
        });
        if (reservationId !== 'reservation-four') {
          expect(result.status).toBe('reserved');
          expect(
            reconcile(ledgerRoot, reservationId, {
              actual: {
                attempts: 2,
                tokens: 8_000,
                runWallClockSeconds: 400,
                costUsdMicros: 160_000,
              },
            }).status,
          ).toBe('reconciled');
        } else {
          expect(result).toMatchObject({ status: 'blocked', reasonCode: 'quota_exhausted' });
        }
      }
    });
  });

  test('fails closed when another process already holds the atomic transaction lock', () => {
    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'layout-seed').status).toBe('reserved');
      expect(reconcile(ledgerRoot, 'layout-seed').status).toBe('reconciled');

      const descriptor = openSync(join(ledgerRoot, 'locks', 'transaction.lock'), 'wx', 0o600);
      closeSync(descriptor);
      expect(reserve(ledgerRoot, 'blocked-by-lock')).toMatchObject({
        status: 'blocked',
        authority: 'diagnostic',
        evidenceEligible: false,
        reasonCode: 'ledger_lock_unavailable',
      });
    });
  });

  test('uses create-only locking across processes so exactly one concurrent reservation succeeds', async () => {
    await withLedgerAsync(async (ledgerRoot) => {
      expect(reserve(ledgerRoot, 'cross-process-seed').status).toBe('reserved');
      expect(reconcile(ledgerRoot, 'cross-process-seed').status).toBe('reconciled');

      const moduleUrl = new URL(
        '../../../scripts/evals/qualification/live-governance-ledger-v1.ts',
        import.meta.url,
      ).href;
      const childProgram = [
        'const [moduleUrl, ledgerRoot] = Bun.argv.slice(1);',
        'const ledger = await import(moduleUrl);',
        "const result = ledger.reserveLiveGovernanceQuotaV1({ ledgerRoot, routePolicyDigest: 'sha256:' + 'a'.repeat(64), requested: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 } });",
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n');
      const children = [0, 1, 2].map((childIndex) => ({
        childIndex,
        child: Bun.spawn([process.execPath, '--eval', childProgram, moduleUrl, ledgerRoot], {
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      }));
      const outcomes = await Promise.all(
        children.map(async ({ childIndex, child }) => {
          const exitCode = await child.exited;
          const stdout = await new Response(child.stdout).text();
          await new Response(child.stderr).text();
          return {
            childIndex,
            exitCode,
            result: JSON.parse(stdout) as {
              status?: string;
              reasonCode?: string;
              reservation?: { reservationId?: string };
            },
          };
        }),
      );
      expect(outcomes.every((outcome) => outcome.exitCode === 0)).toBe(true);
      expect(outcomes.filter((outcome) => outcome.result.status === 'reserved')).toHaveLength(1);
      expect(
        outcomes.every(
          (outcome) =>
            outcome.result.status === 'reserved' ||
            outcome.result.reasonCode === 'ledger_lock_unavailable' ||
            outcome.result.reasonCode === 'concurrency_exhausted',
        ),
      ).toBe(true);

      const winnerReservationId = outcomes.find((outcome) => outcome.result.status === 'reserved')
        ?.result.reservation?.reservationId;
      if (!winnerReservationId) throw new Error('expected_cross_process_reservation');
      const reconcileProgram = [
        'const [moduleUrl, ledgerRoot, reservationId] = Bun.argv.slice(1);',
        'const ledger = await import(moduleUrl);',
        "const result = ledger.reconcileLiveGovernanceQuotaV1({ ledgerRoot, reservationId, routePolicyDigest: 'sha256:' + 'a'.repeat(64), actual: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 } });",
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n');
      const terminalChildren = [0, 1].map(() =>
        Bun.spawn(
          [
            process.execPath,
            '--eval',
            reconcileProgram,
            moduleUrl,
            ledgerRoot,
            winnerReservationId,
          ],
          {
            stdout: 'pipe',
            stderr: 'pipe',
          },
        ),
      );
      const terminalOutcomes = await Promise.all(
        terminalChildren.map(async (child) => {
          const exitCode = await child.exited;
          const stdout = await new Response(child.stdout).text();
          await new Response(child.stderr).text();
          return {
            exitCode,
            result: JSON.parse(stdout) as { status?: string; reasonCode?: string },
          };
        }),
      );
      expect(terminalOutcomes.every((outcome) => outcome.exitCode === 0)).toBe(true);
      expect(
        terminalOutcomes.filter((outcome) => outcome.result.status === 'reconciled'),
      ).toHaveLength(1);
      expect(
        terminalOutcomes.every(
          (outcome) =>
            outcome.result.status === 'reconciled' ||
            outcome.result.reasonCode === 'ledger_lock_unavailable' ||
            outcome.result.reasonCode === 'reservation_not_active',
        ),
      ).toBe(true);
    });
  });

  test('enforces the profile-wide maximum concurrency across route-policy digests', () => {
    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'active-one').status).toBe('reserved');
      expect(
        reserve(ledgerRoot, 'active-two', { routePolicyDigest: OTHER_POLICY_DIGEST }),
      ).toMatchObject({
        status: 'blocked',
        reasonCode: 'concurrency_exhausted',
      });
    });
  });

  test('enforces day and month quota globally instead of allowing route-policy bypass', () => {
    withLedger((ledgerRoot) => {
      const profileMaximum = {
        attempts: 3,
        tokens: 12_288,
        runWallClockSeconds: 600,
        costUsdMicros: 250_000,
      };
      expect(reserve(ledgerRoot, 'global-quota-one', { requested: profileMaximum }).status).toBe(
        'reserved',
      );
      expect(reconcile(ledgerRoot, 'global-quota-one', { actual: profileMaximum }).status).toBe(
        'reconciled',
      );
      expect(
        reserve(ledgerRoot, 'global-quota-two', {
          routePolicyDigest: OTHER_POLICY_DIGEST,
          requested: profileMaximum,
        }).status,
      ).toBe('reserved');
      expect(
        reconcile(ledgerRoot, 'global-quota-two', {
          routePolicyDigest: OTHER_POLICY_DIGEST,
          actual: profileMaximum,
        }).status,
      ).toBe('reconciled');
      expect(
        reserve(ledgerRoot, 'global-quota-blocked', {
          routePolicyDigest: `sha256:${'c'.repeat(64)}`,
        }),
      ).toMatchObject({ status: 'blocked', reasonCode: 'quota_exhausted' });
    });
  });

  test('charges an expired unreconciled reservation at the full governance maximum', () => {
    withLedger((ledgerRoot) => {
      expect(
        reserve(ledgerRoot, 'expired-reservation', {
          leaseSeconds: 1,
          requested: REQUESTED,
        }).status,
      ).toBe('reserved');
      const expiredReservationId = reservationIdFor(ledgerRoot, 'expired-reservation');
      const originalReservationBytes = readFileSync(
        join(ledgerRoot, 'records', `${expiredReservationId}.reservation.json`),
        'utf8',
      );

      expect(
        reserve(ledgerRoot, 'next-reservation', {
          now: LATER,
          requested: REQUESTED,
        }).status,
      ).toBe('reserved');
      const originalReservation = readRecord(ledgerRoot, 'expired-reservation');
      const expired = readRecord(ledgerRoot, 'expired-reservation', 'terminal');
      expect(
        readFileSync(
          join(ledgerRoot, 'records', `${expiredReservationId}.reservation.json`),
          'utf8',
        ),
      ).toBe(originalReservationBytes);
      expect(isLiveGovernanceLedgerRecordV1(originalReservation)).toBe(true);
      expect(isLiveGovernanceLedgerTerminalEventV1(expired)).toBe(true);
      if (!isLiveGovernanceLedgerTerminalEventV1(expired))
        throw new Error('expected_expired_event');
      expect(expired.quotaLedgers.day).toMatchObject({
        status: 'expired',
        reserved: {
          attempts: 3,
          tokens: 12_288,
          runWallClockSeconds: 600,
          costUsdMicros: 250_000,
        },
      });
      expect(reconcile(ledgerRoot, 'expired-reservation', { now: LATER })).toMatchObject({
        status: 'blocked',
        reasonCode: 'reservation_not_active',
      });
    });
  });

  test('never lets reconciliation exceed the pre-dispatch reservation', () => {
    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'bounded-reservation').status).toBe('reserved');
      expect(
        reconcile(ledgerRoot, 'bounded-reservation', {
          actual: { ...REQUESTED, attempts: REQUESTED.attempts + 1 },
        }),
      ).toMatchObject({
        status: 'blocked',
        reasonCode: 'reconciliation_exceeds_reservation',
      });
      expect(reconcile(ledgerRoot, 'bounded-reservation').status).toBe('reconciled');
    });
  });

  test('charges elapsed reservation-to-terminal wall time even when a caller underreports it', () => {
    withLedger((ledgerRoot) => {
      const timeBounded = {
        attempts: 1,
        tokens: 100,
        runWallClockSeconds: 5,
        costUsdMicros: 100,
      };
      expect(
        reserve(ledgerRoot, 'elapsed-time-reservation', {
          requested: timeBounded,
          leaseSeconds: 5,
        }).status,
      ).toBe('reserved');
      const reconciled = reconcile(ledgerRoot, 'elapsed-time-reservation', {
        now: LATER,
        actual: { ...timeBounded, runWallClockSeconds: 0 },
      });
      expect(reconciled.status).toBe('reconciled');
      if (reconciled.status !== 'reconciled') throw new Error('expected_elapsed_reconciliation');
      expect(reconciled.reservation.dayQuotaLedger.reconciled).toMatchObject({
        runWallClockSeconds: 2,
      });

      expect(
        reserve(ledgerRoot, 'elapsed-time-over-budget', {
          requested: { ...REQUESTED, runWallClockSeconds: 1 },
          leaseSeconds: 10,
        }).status,
      ).toBe('reserved');
      expect(
        reconcile(ledgerRoot, 'elapsed-time-over-budget', {
          now: LATER,
          actual: { ...REQUESTED, runWallClockSeconds: 0 },
        }),
      ).toMatchObject({ status: 'blocked', reasonCode: 'reconciliation_exceeds_reservation' });
    });
  });

  test('keeps reservation and terminal records append-only, and fails closed on terminal duplication or tampering', () => {
    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'append-only-reservation').status).toBe('reserved');
      const appendOnlyReservationId = reservationIdFor(ledgerRoot, 'append-only-reservation');
      const reservationPath = join(
        ledgerRoot,
        'records',
        `${appendOnlyReservationId}.reservation.json`,
      );
      const reservationBytes = readFileSync(reservationPath, 'utf8');
      expect(reconcile(ledgerRoot, 'append-only-reservation').status).toBe('reconciled');
      const terminalPath = join(ledgerRoot, 'records', `${appendOnlyReservationId}.terminal.json`);
      const terminalBytes = readFileSync(terminalPath, 'utf8');
      expect(readdirSync(join(ledgerRoot, 'records')).sort()).toEqual([
        `${appendOnlyReservationId}.reservation.json`,
        `${appendOnlyReservationId}.terminal.json`,
      ]);
      expect(readFileSync(reservationPath, 'utf8')).toBe(reservationBytes);
      expect(reconcile(ledgerRoot, 'append-only-reservation')).toMatchObject({
        status: 'blocked',
        reasonCode: 'reservation_not_active',
      });
      expect(readFileSync(terminalPath, 'utf8')).toBe(terminalBytes);
      expect(statSync(reservationPath).mode & 0o777).toBe(0o600);
      expect(statSync(terminalPath).mode & 0o777).toBe(0o600);

      writeFileSync(terminalPath, '{}', { mode: 0o600 });
      expect(reserve(ledgerRoot, 'after-terminal-tamper')).toMatchObject({
        status: 'blocked',
        reasonCode: 'ledger_integrity_invalid',
      });
    });
  });

  test('rejects unknown, nonregular, and symlink ledger records without following them', () => {
    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'unknown-record-seed').status).toBe('reserved');
      expect(reconcile(ledgerRoot, 'unknown-record-seed').status).toBe('reconciled');
      writeFileSync(join(ledgerRoot, 'records', 'unexpected.txt'), 'metadata-only', {
        mode: 0o600,
      });
      expect(reserve(ledgerRoot, 'unknown-record-blocked')).toMatchObject({
        status: 'blocked',
        reasonCode: 'ledger_integrity_invalid',
      });
    });

    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'nonregular-record-seed').status).toBe('reserved');
      expect(reconcile(ledgerRoot, 'nonregular-record-seed').status).toBe('reconciled');
      mkdirSync(
        join(ledgerRoot, 'records', 'l3-11111111-1111-4111-8111-111111111111.reservation.json'),
        { mode: 0o700 },
      );
      expect(reserve(ledgerRoot, 'nonregular-record-blocked')).toMatchObject({
        status: 'blocked',
        reasonCode: 'ledger_integrity_invalid',
      });
    });

    withLedger((ledgerRoot) => {
      expect(reserve(ledgerRoot, 'symlink-record-seed').status).toBe('reserved');
      expect(reconcile(ledgerRoot, 'symlink-record-seed').status).toBe('reconciled');
      symlinkSync(
        '/dev/null',
        join(ledgerRoot, 'records', 'l3-22222222-2222-4222-8222-222222222222.reservation.json'),
      );
      expect(reserve(ledgerRoot, 'symlink-record-blocked')).toMatchObject({
        status: 'blocked',
        reasonCode: 'ledger_integrity_invalid',
      });
    });
  });

  test('retains only owner-readable metadata audit records and never persists caller paths or secrets', () => {
    withLedger((ledgerRoot) => {
      expect(
        reserve(ledgerRoot, 'privacy-rejected', {
          credential: 'credential-sentinel-never-persisted',
          endpoint: 'https://provider.example.invalid/full-endpoint',
          reservationId: 'prompt-body-never-persisted',
        }),
      ).toMatchObject({ status: 'blocked', reasonCode: 'reservation_invalid' });
      const result = reserve(ledgerRoot, 'privacy-reservation');
      expect(result.status).toBe('reserved');
      const serialized = readFileSync(
        join(
          ledgerRoot,
          'records',
          `${reservationIdFor(ledgerRoot, 'privacy-reservation')}.reservation.json`,
        ),
        'utf8',
      );
      for (const prohibited of [
        ledgerRoot,
        'credential-sentinel-never-persisted',
        'https://provider.example.invalid/full-endpoint',
        'prompt-body-never-persisted',
        'response-body-never-persisted',
        'reasoning-body-never-persisted',
        'workspace-source-never-persisted',
      ]) {
        expect(serialized).not.toContain(prohibited);
      }
      expect(serialized).not.toContain('"ledgerRoot"');
      expect(serialized).not.toContain('"endpoint"');
      expect(serialized).not.toContain('"credential"');

      const audit = readRecord(ledgerRoot, 'privacy-reservation');
      expect(isLiveGovernanceLedgerRecordV1(audit)).toBe(true);
      if (!isLiveGovernanceLedgerRecordV1(audit)) throw new Error('expected_audit_record');
      expect(
        Date.parse(audit.auditRetention.retainedUntil) -
          Date.parse(audit.auditRetention.observedAt),
      ).toBeGreaterThanOrEqual(LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1 * 1_000);
      expect(audit.auditRetention.storage).toEqual({
        acl: 'local_owner_only',
        encryption: 'local_owner_disk_encryption',
        audit: 'local_metadata_audit',
      });
      for (const directory of [
        ledgerRoot,
        join(ledgerRoot, 'records'),
        join(ledgerRoot, 'locks'),
      ]) {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
      expect(
        statSync(
          join(
            ledgerRoot,
            'records',
            `${reservationIdFor(ledgerRoot, 'privacy-reservation')}.reservation.json`,
          ),
        ).mode & 0o777,
      ).toBe(0o600);
    });
  });

  test('requires an explicit absolute ledger root and does not load ambient configuration', () => {
    expect(
      reserveLiveGovernanceQuotaV1({
        ledgerRoot: 'relative-ledger-root',
        routePolicyDigest: POLICY_DIGEST,
        requested: REQUESTED,
      }),
    ).toMatchObject({ status: 'blocked', reasonCode: 'ledger_root_invalid' });
    expect(
      reserveLiveGovernanceQuotaV1({} as Parameters<typeof reserveLiveGovernanceQuotaV1>[0]),
    ).toMatchObject({
      status: 'blocked',
      reasonCode: 'ledger_root_invalid',
    });

    withLedger((ledgerRoot) => {
      expect(
        reserveLiveGovernanceQuotaV1({
          ledgerRoot,
          routePolicyDigest: POLICY_DIGEST,
          requested: REQUESTED,
          now: NOW,
        } as unknown as Parameters<typeof reserveLiveGovernanceQuotaV1>[0]),
      ).toMatchObject({ status: 'blocked', reasonCode: 'reservation_invalid' });
    });

    const source = readFileSync(
      new URL('../../../scripts/evals/qualification/live-governance-ledger-v1.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'process.env',
      'loadAgentConfig',
      'loadProductionAgentConfig',
      'fetch(',
      'generateText(',
      'ReleaseEvidenceV1',
      'gate-evaluator',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
