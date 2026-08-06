import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJson,
  sha256DomainSeparated,
} from '../../release/canonical-json';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
  type EvidenceQuotaLedgerV1,
  type EvidenceRetentionWitnessV1,
  evidenceQuotaLedgerV1Schema,
  evidenceRetentionWitnessV1Schema,
} from '../contracts/qualification/evidence/governance-v1';
import { isQualificationSafeIdentifierV1 } from '../contracts/qualification/evidence/metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RESERVATION_ID = /^l3-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_FILE =
  /^(l3-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(reservation|terminal)\.json$/;
const TRANSACTION_LOCK_FILE = 'transaction.lock';
// The fixed supervisor witness is a no-secret precondition checked by the
// L3 runners before reservation. It is not a ledger record or evidence.
const ROOT_ENTRIES = new Set(['locks', 'records', 'live-scratch-supervisor-v1']);
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

/** ADR-0070 requires a ledger audit trail for at least ninety days. */
export const LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1 = 7_776_000;

const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
const quotaCounterV1Schema = z
  .object({
    attempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    runWallClockSeconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    costUsdMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const reservationQuotaCounterV1Schema = z
  .object({
    attempts: z.number().int().positive().max(profile.quotas.perRun.attempts),
    tokens: z.number().int().positive().max(profile.quotas.perRun.tokens),
    runWallClockSeconds: z.number().int().positive().max(profile.quotas.perRun.runWallClockSeconds),
    costUsdMicros: z.number().int().positive().max(profile.quotas.perRun.costUsdMicros),
  })
  .strict();
const digestSchema = z.string().regex(DIGEST);
const reservationIdSchema = z
  .string()
  .regex(RESERVATION_ID)
  .refine(isQualificationSafeIdentifierV1, {
    message: 'reservation identifier must be safe diagnostic metadata',
  });
const isoTimestampSchema = z.iso.datetime({ offset: true });
const ownerStorageV1Schema = z
  .object({
    acl: z.literal('local_owner_only'),
    encryption: z.literal('local_owner_disk_encryption'),
    audit: z.literal('local_metadata_audit'),
  })
  .strict();

export type LiveGovernanceQuotaCountersV1 = z.infer<typeof quotaCounterV1Schema>;

const auditRetentionMaterialV1Schema = z
  .object({
    schema: z.literal('LiveGovernanceLedgerAuditRetentionV1'),
    version: z.literal(1),
    observedAt: isoTimestampSchema,
    retainedUntil: isoTimestampSchema,
    minimumRetentionSeconds: z.literal(LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1),
    storage: ownerStorageV1Schema,
  })
  .strict();

export type LiveGovernanceLedgerAuditRetentionMaterialV1 = z.infer<
  typeof auditRetentionMaterialV1Schema
>;

export function computeLiveGovernanceLedgerAuditRetentionDigestV1(
  material: LiveGovernanceLedgerAuditRetentionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-governance-ledger-audit-retention.v1',
    canonicalJsonBytes(auditRetentionMaterialV1Schema.parse(material)),
  );
}

export const liveGovernanceLedgerAuditRetentionV1Schema = auditRetentionMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    if (
      Date.parse(material.retainedUntil) - Date.parse(material.observedAt) <
      LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1 * 1_000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['retainedUntil'],
        message: 'ledger audit material must retain for at least ninety days',
      });
    }
    if (recordDigest !== computeLiveGovernanceLedgerAuditRetentionDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'ledger audit retention digest mismatch',
      });
    }
  });

export type LiveGovernanceLedgerAuditRetentionV1 = z.infer<
  typeof liveGovernanceLedgerAuditRetentionV1Schema
>;

export function buildLiveGovernanceLedgerAuditRetentionV1(
  material: LiveGovernanceLedgerAuditRetentionMaterialV1,
): LiveGovernanceLedgerAuditRetentionV1 {
  const parsed = auditRetentionMaterialV1Schema.parse(material);
  return liveGovernanceLedgerAuditRetentionV1Schema.parse({
    ...parsed,
    recordDigest: computeLiveGovernanceLedgerAuditRetentionDigestV1(parsed),
  });
}

const reservationRecordMaterialV1Schema = z
  .object({
    schema: z.literal('LiveGovernanceReservationLedgerV1'),
    version: z.literal(1),
    reservationId: reservationIdSchema,
    reservedAt: isoTimestampSchema,
    leaseExpiresAt: isoTimestampSchema,
    quotaLedgers: z
      .object({
        day: evidenceQuotaLedgerV1Schema,
        month: evidenceQuotaLedgerV1Schema,
      })
      .strict(),
    /**
     * This is the canonical ephemeral-local scratch deletion witness.  It is
     * deliberately distinct from the 90-day metadata ledger audit record.
     */
    scratchDeletionWitness: evidenceRetentionWitnessV1Schema,
    auditRetention: liveGovernanceLedgerAuditRetentionV1Schema,
  })
  .strict();

export type LiveGovernanceReservationLedgerMaterialV1 = z.infer<
  typeof reservationRecordMaterialV1Schema
>;

export function computeLiveGovernanceReservationLedgerDigestV1(
  material: LiveGovernanceReservationLedgerMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-governance-reservation-ledger.v1',
    canonicalJsonBytes(reservationRecordMaterialV1Schema.parse(material)),
  );
}

export const liveGovernanceReservationLedgerV1Schema = reservationRecordMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const day = material.quotaLedgers.day;
    const month = material.quotaLedgers.month;
    const expectedProfile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    const same = (left: unknown, right: unknown): boolean =>
      JSON.stringify(left) === JSON.stringify(right);

    if (Date.parse(material.leaseExpiresAt) <= Date.parse(material.reservedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['leaseExpiresAt'],
        message: 'reservation lease must expire after its reservation timestamp',
      });
    }
    if (
      day.period !== 'day' ||
      month.period !== 'month' ||
      day.reservationId !== material.reservationId ||
      month.reservationId !== material.reservationId ||
      day.profileId !== expectedProfile.profileId ||
      month.profileId !== expectedProfile.profileId ||
      day.profileDigest !== expectedProfile.profileDigest ||
      month.profileDigest !== expectedProfile.profileDigest ||
      day.routePolicyDigest !== month.routePolicyDigest ||
      day.status !== 'reserved' ||
      month.status !== 'reserved' ||
      !same(day.reserved, month.reserved) ||
      day.reconciled !== undefined ||
      month.reconciled !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quotaLedgers'],
        message: 'ledger day/month records must be one exact ephemeral-local reservation',
      });
    }
    if (
      material.scratchDeletionWitness.profileId !== expectedProfile.profileId ||
      material.scratchDeletionWitness.profileDigest !== expectedProfile.profileDigest ||
      material.scratchDeletionWitness.retentionClass !== 'ephemeral_local' ||
      material.scratchDeletionWitness.observedAt !== material.reservedAt
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scratchDeletionWitness'],
        message: 'scratch deletion witness must bind this ephemeral-local reservation timestamp',
      });
    }
    if (material.auditRetention.observedAt !== material.reservedAt) {
      context.addIssue({
        code: 'custom',
        path: ['auditRetention', 'observedAt'],
        message: 'ledger audit retention must begin when the reservation is written',
      });
    }
    if (recordDigest !== computeLiveGovernanceReservationLedgerDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'reservation ledger digest mismatch',
      });
    }
  });

export type LiveGovernanceReservationLedgerV1 = z.infer<
  typeof liveGovernanceReservationLedgerV1Schema
>;

export function buildLiveGovernanceReservationLedgerV1(
  material: LiveGovernanceReservationLedgerMaterialV1,
): LiveGovernanceReservationLedgerV1 {
  const parsed = reservationRecordMaterialV1Schema.parse(material);
  return liveGovernanceReservationLedgerV1Schema.parse({
    ...parsed,
    recordDigest: computeLiveGovernanceReservationLedgerDigestV1(parsed),
  });
}

const terminalEventMaterialV1Schema = z
  .object({
    schema: z.literal('LiveGovernanceLedgerTerminalEventV1'),
    version: z.literal(1),
    reservationId: reservationIdSchema,
    terminalAt: isoTimestampSchema,
    terminalStatus: z.enum(['reconciled', 'expired']),
    quotaLedgers: z
      .object({
        day: evidenceQuotaLedgerV1Schema,
        month: evidenceQuotaLedgerV1Schema,
      })
      .strict(),
    auditRetention: liveGovernanceLedgerAuditRetentionV1Schema,
  })
  .strict();

export type LiveGovernanceLedgerTerminalEventMaterialV1 = z.infer<
  typeof terminalEventMaterialV1Schema
>;

export function computeLiveGovernanceLedgerTerminalEventDigestV1(
  material: LiveGovernanceLedgerTerminalEventMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.live-governance-ledger-terminal-event.v1',
    canonicalJsonBytes(terminalEventMaterialV1Schema.parse(material)),
  );
}

export const liveGovernanceLedgerTerminalEventV1Schema = terminalEventMaterialV1Schema
  .extend({ recordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    const day = material.quotaLedgers.day;
    const month = material.quotaLedgers.month;
    const expectedProfile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    const same = (left: unknown, right: unknown): boolean =>
      JSON.stringify(left) === JSON.stringify(right);
    if (
      day.period !== 'day' ||
      month.period !== 'month' ||
      day.reservationId !== material.reservationId ||
      month.reservationId !== material.reservationId ||
      day.profileId !== expectedProfile.profileId ||
      month.profileId !== expectedProfile.profileId ||
      day.profileDigest !== expectedProfile.profileDigest ||
      month.profileDigest !== expectedProfile.profileDigest ||
      day.routePolicyDigest !== month.routePolicyDigest ||
      day.status !== material.terminalStatus ||
      month.status !== material.terminalStatus ||
      !same(day.reserved, month.reserved) ||
      !same(day.reconciled, month.reconciled)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['quotaLedgers'],
        message:
          'terminal event day/month records must be one exact ephemeral-local terminal state',
      });
    }
    if (material.auditRetention.observedAt !== material.terminalAt) {
      context.addIssue({
        code: 'custom',
        path: ['auditRetention', 'observedAt'],
        message: 'terminal event audit retention must begin when the event is written',
      });
    }
    if (recordDigest !== computeLiveGovernanceLedgerTerminalEventDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['recordDigest'],
        message: 'terminal event digest mismatch',
      });
    }
  });

export type LiveGovernanceLedgerTerminalEventV1 = z.infer<
  typeof liveGovernanceLedgerTerminalEventV1Schema
>;

export function buildLiveGovernanceLedgerTerminalEventV1(
  material: LiveGovernanceLedgerTerminalEventMaterialV1,
): LiveGovernanceLedgerTerminalEventV1 {
  const parsed = terminalEventMaterialV1Schema.parse(material);
  return liveGovernanceLedgerTerminalEventV1Schema.parse({
    ...parsed,
    recordDigest: computeLiveGovernanceLedgerTerminalEventDigestV1(parsed),
  });
}

const reserveInputV1Schema = z
  .object({
    ledgerRoot: z.string().min(1),
    routePolicyDigest: digestSchema,
    requested: reservationQuotaCounterV1Schema,
    leaseSeconds: z
      .number()
      .int()
      .positive()
      .max(profile.quotas.perRun.runWallClockSeconds)
      .optional(),
  })
  .strict();
export type ReserveLiveGovernanceQuotaInputV1 = z.input<typeof reserveInputV1Schema>;

const reconcileInputV1Schema = z
  .object({
    ledgerRoot: z.string().min(1),
    reservationId: reservationIdSchema,
    routePolicyDigest: digestSchema,
    actual: quotaCounterV1Schema,
  })
  .strict();
export type ReconcileLiveGovernanceQuotaInputV1 = z.input<typeof reconcileInputV1Schema>;

export const LIVE_GOVERNANCE_LEDGER_BLOCKED_REASON_CODES_V1 = [
  'ledger_root_invalid',
  'ledger_layout_invalid',
  'ledger_integrity_invalid',
  'ledger_lock_unavailable',
  'ledger_unavailable',
  'reservation_invalid',
  'reservation_duplicate',
  'reservation_not_found',
  'reservation_not_active',
  'reconciliation_time_invalid',
  'reconciliation_exceeds_reservation',
  'quota_exhausted',
  'concurrency_exhausted',
] as const;
export type LiveGovernanceLedgerBlockedReasonCodeV1 =
  (typeof LIVE_GOVERNANCE_LEDGER_BLOCKED_REASON_CODES_V1)[number];

export type LiveGovernanceReservationReceiptV1 = Readonly<{
  authority: 'diagnostic';
  evidenceEligible: false;
  reservationId: string;
  profileId: string;
  profileDigest: string;
  routePolicyDigest: string;
  dayQuotaLedger: EvidenceQuotaLedgerV1;
  monthQuotaLedger: EvidenceQuotaLedgerV1;
  scratchDeletionWitness: EvidenceRetentionWitnessV1;
  auditRetention: LiveGovernanceLedgerAuditRetentionV1;
  recordDigest: string;
}>;

export type LiveGovernanceReservationResultV1 =
  | Readonly<{
      status: 'reserved';
      reservation: LiveGovernanceReservationReceiptV1;
    }>
  | Readonly<{
      status: 'blocked';
      authority: 'diagnostic';
      evidenceEligible: false;
      reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1;
    }>;

export type LiveGovernanceReconciliationResultV1 =
  | Readonly<{
      status: 'reconciled';
      reservation: LiveGovernanceReservationReceiptV1;
    }>
  | Readonly<{
      status: 'blocked';
      authority: 'diagnostic';
      evidenceEligible: false;
      reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1;
    }>;

type LedgerLayoutV1 = Readonly<{
  recordsDirectory: string;
  lockDirectory: string;
}>;

class LedgerFailureV1 extends Error {
  readonly reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1;

  constructor(reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1) {
    super(reasonCode);
    this.name = 'LedgerFailureV1';
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1): never {
  throw new LedgerFailureV1(reasonCode);
}

function blocked<
  T extends LiveGovernanceReservationResultV1 | LiveGovernanceReconciliationResultV1,
>(reasonCode: LiveGovernanceLedgerBlockedReasonCodeV1): T {
  return {
    status: 'blocked',
    authority: 'diagnostic',
    evidenceEligible: false,
    reasonCode,
  } as T;
}

function isOwnerOnly(stat: Stats, expected: 'directory' | 'file'): boolean {
  const currentUid = process.getuid?.();
  if (typeof currentUid !== 'number' || stat.uid !== currentUid) return false;
  if (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) return false;
  return (stat.mode & 0o077) === 0 && (expected !== 'file' || stat.nlink === 1);
}

function assertOwnerOnlyDirectory(path: string, create: boolean): void {
  try {
    if (!existsSync(path)) {
      if (!create) fail('ledger_layout_invalid');
      mkdirSync(path, { mode: OWNER_ONLY_DIRECTORY_MODE });
      chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !isOwnerOnly(stat, 'directory')) fail('ledger_layout_invalid');
  } catch (error) {
    if (error instanceof LedgerFailureV1) throw error;
    fail('ledger_layout_invalid');
  }
}

function assertOwnerOnlyRecordFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !isOwnerOnly(stat, 'file')) fail('ledger_integrity_invalid');
  } catch (error) {
    if (error instanceof LedgerFailureV1) throw error;
    fail('ledger_integrity_invalid');
  }
}

function prepareLedgerLayout(ledgerRoot: string): LedgerLayoutV1 {
  if (!isAbsolute(ledgerRoot)) fail('ledger_root_invalid');
  assertOwnerOnlyDirectory(ledgerRoot, true);

  try {
    const rootEntries = readdirSync(ledgerRoot);
    if (rootEntries.some((entry) => !ROOT_ENTRIES.has(entry))) fail('ledger_layout_invalid');
  } catch (error) {
    if (error instanceof LedgerFailureV1) throw error;
    fail('ledger_layout_invalid');
  }

  const recordsDirectory = join(ledgerRoot, 'records');
  const lockDirectory = join(ledgerRoot, 'locks');
  assertOwnerOnlyDirectory(recordsDirectory, true);
  assertOwnerOnlyDirectory(lockDirectory, true);

  try {
    const lockEntries = readdirSync(lockDirectory);
    if (lockEntries.some((entry) => entry !== TRANSACTION_LOCK_FILE)) fail('ledger_layout_invalid');
    if (lockEntries.includes(TRANSACTION_LOCK_FILE)) {
      assertOwnerOnlyRecordFile(join(lockDirectory, TRANSACTION_LOCK_FILE));
    }
  } catch (error) {
    if (error instanceof LedgerFailureV1) throw error;
    fail('ledger_layout_invalid');
  }

  return { recordsDirectory, lockDirectory };
}

type LedgerRecordKindV1 = 'reservation' | 'terminal';
type LedgerStateV1 = Readonly<{
  reservations: ReadonlyMap<string, LiveGovernanceReservationLedgerV1>;
  terminalEvents: ReadonlyMap<string, LiveGovernanceLedgerTerminalEventV1>;
}>;

function recordFileName(reservationId: string, kind: LedgerRecordKindV1): string {
  return `${reservationId}.${kind}.json`;
}

function sameCounters(
  left: LiveGovernanceQuotaCountersV1,
  right: LiveGovernanceQuotaCountersV1,
): boolean {
  return (
    left.attempts === right.attempts &&
    left.tokens === right.tokens &&
    left.runWallClockSeconds === right.runWallClockSeconds &&
    left.costUsdMicros === right.costUsdMicros
  );
}

function assertTerminalBindsReservation(
  reservation: LiveGovernanceReservationLedgerV1,
  terminal: LiveGovernanceLedgerTerminalEventV1,
): void {
  const reserved = reservation.quotaLedgers.day.reserved;
  const terminalDay = terminal.quotaLedgers.day;
  const terminalAtMs = Date.parse(terminal.terminalAt);
  const reservedAtMs = Date.parse(reservation.reservedAt);
  if (
    terminalDay.routePolicyDigest !== reservation.quotaLedgers.day.routePolicyDigest ||
    terminal.quotaLedgers.day.periodStart !== reservation.quotaLedgers.day.periodStart ||
    terminal.quotaLedgers.month.periodStart !== reservation.quotaLedgers.month.periodStart ||
    terminalAtMs < reservedAtMs
  ) {
    fail('ledger_integrity_invalid');
  }
  if (terminal.terminalStatus === 'reconciled') {
    if (
      Date.parse(terminal.terminalAt) > Date.parse(reservation.leaseExpiresAt) ||
      !terminalDay.reconciled ||
      !sameCounters(terminalDay.reserved, reserved) ||
      exceeds(terminalDay.reconciled, reserved)
    ) {
      fail('ledger_integrity_invalid');
    }
    return;
  }
  if (
    Date.parse(terminal.terminalAt) < Date.parse(reservation.leaseExpiresAt) ||
    !sameCounters(terminalDay.reserved, profile.quotas.perRun)
  ) {
    fail('ledger_integrity_invalid');
  }
}

function loadLedgerState(layout: LedgerLayoutV1): LedgerStateV1 {
  let names: string[];
  try {
    names = readdirSync(layout.recordsDirectory).sort();
  } catch {
    fail('ledger_integrity_invalid');
  }

  const reservations = new Map<string, LiveGovernanceReservationLedgerV1>();
  const terminalEvents = new Map<string, LiveGovernanceLedgerTerminalEventV1>();
  for (const name of names) {
    const match = RECORD_FILE.exec(name);
    if (!match) fail('ledger_integrity_invalid');
    const expectedReservationId = match[1];
    const kind = match[2];
    if (!expectedReservationId || (kind !== 'reservation' && kind !== 'terminal')) {
      fail('ledger_integrity_invalid');
    }
    const recordPath = join(layout.recordsDirectory, name);
    assertOwnerOnlyRecordFile(recordPath);
    try {
      const parsed = parseCanonicalJson(readFileSync(recordPath));
      if (kind === 'reservation') {
        const record = liveGovernanceReservationLedgerV1Schema.parse(parsed);
        if (
          record.reservationId !== expectedReservationId ||
          reservations.has(record.reservationId)
        ) {
          fail('ledger_integrity_invalid');
        }
        reservations.set(record.reservationId, record);
      } else {
        const record = liveGovernanceLedgerTerminalEventV1Schema.parse(parsed);
        if (
          record.reservationId !== expectedReservationId ||
          terminalEvents.has(record.reservationId)
        ) {
          fail('ledger_integrity_invalid');
        }
        terminalEvents.set(record.reservationId, record);
      }
    } catch (error) {
      if (error instanceof LedgerFailureV1) throw error;
      fail('ledger_integrity_invalid');
    }
  }
  for (const [reservationId, terminal] of terminalEvents) {
    const reservation = reservations.get(reservationId);
    if (!reservation) fail('ledger_integrity_invalid');
    assertTerminalBindsReservation(reservation, terminal);
  }
  return { reservations, terminalEvents };
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function appendLedgerRecordAtomically(
  layout: LedgerLayoutV1,
  kind: LedgerRecordKindV1,
  record: LiveGovernanceReservationLedgerV1 | LiveGovernanceLedgerTerminalEventV1,
): void {
  const outputPath = join(layout.recordsDirectory, recordFileName(record.reservationId, kind));
  const temporaryPath = join(layout.recordsDirectory, `.pending-${randomUUID()}`);
  let descriptor: number | undefined;
  let temporaryExists = false;
  let linked = false;
  try {
    if (existsSync(outputPath)) fail('ledger_integrity_invalid');
    descriptor = openSync(temporaryPath, 'wx', OWNER_ONLY_FILE_MODE);
    temporaryExists = true;
    chmodSync(temporaryPath, OWNER_ONLY_FILE_MODE);
    writeSync(descriptor, canonicalJson(record));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    // link(2) is create-only: unlike rename, it cannot replace a prior audit
    // record if a second caller or a malformed state races this transaction.
    linkSync(temporaryPath, outputPath);
    linked = true;
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncDirectory(layout.recordsDirectory);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The caller receives a closed reason code, never this filesystem detail.
      }
    }
    if (temporaryExists && !linked) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // A crash residue is intentionally rejected by the next transaction.
      }
    }
    if (error instanceof LedgerFailureV1) throw error;
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EEXIST'
    ) {
      fail('ledger_integrity_invalid');
    }
    fail('ledger_unavailable');
  }
}

function withLedgerLock<T>(layout: LedgerLayoutV1, action: () => T): T {
  const lockPath = join(layout.lockDirectory, TRANSACTION_LOCK_FILE);
  let descriptor: number | undefined;
  let lockCreated = false;
  try {
    try {
      descriptor = openSync(lockPath, 'wx', OWNER_ONLY_FILE_MODE);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST'
      ) {
        fail('ledger_lock_unavailable');
      }
      fail('ledger_unavailable');
    }
    lockCreated = true;
    chmodSync(lockPath, OWNER_ONLY_FILE_MODE);
    assertOwnerOnlyRecordFile(lockPath);
    const result = action();
    closeSync(descriptor);
    descriptor = undefined;
    unlinkSync(lockPath);
    lockCreated = false;
    fsyncDirectory(layout.lockDirectory);
    return result;
  } catch (error) {
    if (error instanceof LedgerFailureV1) throw error;
    fail('ledger_unavailable');
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // No raw filesystem detail may leave this local ledger boundary.
      }
    }
    if (lockCreated) {
      try {
        unlinkSync(lockPath);
      } catch {
        // An unreleased lock is deliberately fail-closed for the next caller.
      }
    }
  }
  return fail('ledger_unavailable');
}

function utcBuckets(now: string): Readonly<{ day: string; month: string }> {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  return { day, month: `${day.slice(0, 7)}-01` };
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  return new Date(Date.parse(isoTimestamp) + seconds * 1_000).toISOString();
}

function elapsedReservationSeconds(
  reservation: LiveGovernanceReservationLedgerV1,
  terminalAt: string,
): number | undefined {
  const elapsedMs = Date.parse(terminalAt) - Date.parse(reservation.reservedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  return Math.ceil(elapsedMs / 1_000);
}

function exceeds(
  actual: LiveGovernanceQuotaCountersV1,
  maximum: LiveGovernanceQuotaCountersV1,
): boolean {
  return (
    actual.attempts > maximum.attempts ||
    actual.tokens > maximum.tokens ||
    actual.runWallClockSeconds > maximum.runWallClockSeconds ||
    actual.costUsdMicros > maximum.costUsdMicros
  );
}

function addCounters(
  total: LiveGovernanceQuotaCountersV1,
  next: LiveGovernanceQuotaCountersV1,
): LiveGovernanceQuotaCountersV1 {
  const sum = {
    attempts: total.attempts + next.attempts,
    tokens: total.tokens + next.tokens,
    runWallClockSeconds: total.runWallClockSeconds + next.runWallClockSeconds,
    costUsdMicros: total.costUsdMicros + next.costUsdMicros,
  };
  const parsed = quotaCounterV1Schema.safeParse(sum);
  if (!parsed.success) fail('ledger_integrity_invalid');
  return parsed.data;
}

function buildQuotaLedger(
  input: Readonly<{
    period: 'day' | 'month';
    periodStart: string;
    reservationId: string;
    routePolicyDigest: string;
    status: 'reserved' | 'reconciled' | 'expired';
    reserved: LiveGovernanceQuotaCountersV1;
    reconciled?: LiveGovernanceQuotaCountersV1;
  }>,
): EvidenceQuotaLedgerV1 {
  return buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: input.routePolicyDigest,
    period: input.period,
    periodStart: input.periodStart,
    reservationId: input.reservationId,
    status: input.status,
    reserved: input.reserved,
    ...(input.reconciled ? { reconciled: input.reconciled } : {}),
  });
}

function buildReservationRecord(
  input: Readonly<{
    reservationId: string;
    routePolicyDigest: string;
    reservedAt: string;
    leaseExpiresAt: string;
    requested: LiveGovernanceQuotaCountersV1;
    buckets: Readonly<{ day: string; month: string }>;
  }>,
): LiveGovernanceReservationLedgerV1 {
  const auditRetention = buildLiveGovernanceLedgerAuditRetentionV1({
    schema: 'LiveGovernanceLedgerAuditRetentionV1',
    version: 1,
    observedAt: input.reservedAt,
    retainedUntil: addSeconds(input.reservedAt, LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1),
    minimumRetentionSeconds: LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1,
    storage: {
      acl: 'local_owner_only',
      encryption: 'local_owner_disk_encryption',
      audit: 'local_metadata_audit',
    },
  });
  const scratchDeletionWitness = buildEvidenceRetentionWitnessV1({
    schema: 'EvidenceRetentionWitnessV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    retentionClass: 'ephemeral_local',
    storage: {
      acl: 'local_owner_only',
      encryption: 'local_owner_disk_encryption',
      audit: 'local_metadata_audit',
    },
    deleteTrigger: 'process_exit',
    observedAt: input.reservedAt,
  });
  return buildLiveGovernanceReservationLedgerV1({
    schema: 'LiveGovernanceReservationLedgerV1',
    version: 1,
    reservationId: input.reservationId,
    reservedAt: input.reservedAt,
    leaseExpiresAt: input.leaseExpiresAt,
    quotaLedgers: {
      day: buildQuotaLedger({
        period: 'day',
        periodStart: input.buckets.day,
        reservationId: input.reservationId,
        routePolicyDigest: input.routePolicyDigest,
        status: 'reserved',
        reserved: input.requested,
      }),
      month: buildQuotaLedger({
        period: 'month',
        periodStart: input.buckets.month,
        reservationId: input.reservationId,
        routePolicyDigest: input.routePolicyDigest,
        status: 'reserved',
        reserved: input.requested,
      }),
    },
    scratchDeletionWitness,
    auditRetention,
  });
}

function buildTerminalEvent(
  reservation: LiveGovernanceReservationLedgerV1,
  status: 'reconciled' | 'expired',
  counters: LiveGovernanceQuotaCountersV1,
  terminalAt: string,
): LiveGovernanceLedgerTerminalEventV1 {
  const day = reservation.quotaLedgers.day;
  const reserved = status === 'expired' ? profile.quotas.perRun : day.reserved;
  return buildLiveGovernanceLedgerTerminalEventV1({
    schema: 'LiveGovernanceLedgerTerminalEventV1',
    version: 1,
    reservationId: reservation.reservationId,
    terminalAt,
    terminalStatus: status,
    quotaLedgers: {
      day: buildQuotaLedger({
        period: 'day',
        periodStart: reservation.quotaLedgers.day.periodStart,
        reservationId: reservation.reservationId,
        routePolicyDigest: day.routePolicyDigest,
        status,
        reserved,
        ...(status === 'reconciled' ? { reconciled: counters } : {}),
      }),
      month: buildQuotaLedger({
        period: 'month',
        periodStart: reservation.quotaLedgers.month.periodStart,
        reservationId: reservation.reservationId,
        routePolicyDigest: day.routePolicyDigest,
        status,
        reserved,
        ...(status === 'reconciled' ? { reconciled: counters } : {}),
      }),
    },
    auditRetention: buildLiveGovernanceLedgerAuditRetentionV1({
      schema: 'LiveGovernanceLedgerAuditRetentionV1',
      version: 1,
      observedAt: terminalAt,
      retainedUntil: addSeconds(terminalAt, LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1),
      minimumRetentionSeconds: LIVE_GOVERNANCE_LEDGER_AUDIT_RETENTION_SECONDS_V1,
      storage: {
        acl: 'local_owner_only',
        encryption: 'local_owner_disk_encryption',
        audit: 'local_metadata_audit',
      },
    }),
  });
}

function expireUnreconciledReservations(
  layout: LedgerLayoutV1,
  state: LedgerStateV1,
  now: string,
): LedgerStateV1 {
  const nowMs = Date.parse(now);
  const terminalEvents = new Map(state.terminalEvents);
  for (const reservation of state.reservations.values()) {
    if (
      terminalEvents.has(reservation.reservationId) ||
      Date.parse(reservation.leaseExpiresAt) > nowMs
    ) {
      continue;
    }
    // A missed terminal reconciliation appends a separate immutable event. The
    // original reservation remains intact and the effective charge is the full
    // governance per-run ceiling.
    const expired = buildTerminalEvent(reservation, 'expired', profile.quotas.perRun, now);
    appendLedgerRecordAtomically(layout, 'terminal', expired);
    terminalEvents.set(reservation.reservationId, expired);
  }
  return { reservations: state.reservations, terminalEvents };
}

function receipt(
  reservation: LiveGovernanceReservationLedgerV1,
  terminal?: LiveGovernanceLedgerTerminalEventV1,
): LiveGovernanceReservationReceiptV1 {
  const quotaLedgers = terminal?.quotaLedgers ?? reservation.quotaLedgers;
  const day = quotaLedgers.day;
  return {
    authority: 'diagnostic',
    evidenceEligible: false,
    reservationId: reservation.reservationId,
    profileId: day.profileId,
    profileDigest: day.profileDigest,
    routePolicyDigest: day.routePolicyDigest,
    dayQuotaLedger: day,
    monthQuotaLedger: quotaLedgers.month,
    scratchDeletionWitness: reservation.scratchDeletionWitness,
    auditRetention: terminal?.auditRetention ?? reservation.auditRetention,
    recordDigest: terminal?.recordDigest ?? reservation.recordDigest,
  };
}

function bucketUsage(
  state: LedgerStateV1,
  period: 'day' | 'month',
  periodStart: string,
): LiveGovernanceQuotaCountersV1 {
  let total: LiveGovernanceQuotaCountersV1 = {
    attempts: 0,
    tokens: 0,
    runWallClockSeconds: 0,
    costUsdMicros: 0,
  };
  for (const reservation of state.reservations.values()) {
    const terminal = state.terminalEvents.get(reservation.reservationId);
    const ledger = (terminal?.quotaLedgers ?? reservation.quotaLedgers)[period];
    if (ledger.periodStart === periodStart) {
      if (terminal?.terminalStatus === 'reconciled') {
        const reconciled = terminal.quotaLedgers.day.reconciled;
        if (!reconciled) fail('ledger_integrity_invalid');
        total = addCounters(total, reconciled);
      } else {
        total = addCounters(total, ledger.reserved);
      }
    }
  }
  return total;
}

function activeReservations(state: LedgerStateV1): number {
  return [...state.reservations.values()].filter(
    (reservation) => !state.terminalEvents.has(reservation.reservationId),
  ).length;
}

function hasAbsoluteLedgerRoot(input: unknown): boolean {
  try {
    if (typeof input !== 'object' || input === null || !('ledgerRoot' in input)) return false;
    const ledgerRoot = (input as { ledgerRoot?: unknown }).ledgerRoot;
    return typeof ledgerRoot === 'string' && isAbsolute(ledgerRoot);
  } catch {
    return false;
  }
}

function parseReserveInput(
  input: ReserveLiveGovernanceQuotaInputV1,
): z.output<typeof reserveInputV1Schema> | undefined {
  const parsed = reserveInputV1Schema.safeParse(input);
  if (!parsed.success || !hasAbsoluteLedgerRoot(input)) return undefined;
  return parsed.data;
}

function parseReconcileInput(
  input: ReconcileLiveGovernanceQuotaInputV1,
): z.output<typeof reconcileInputV1Schema> | undefined {
  const parsed = reconcileInputV1Schema.safeParse(input);
  if (!parsed.success || !hasAbsoluteLedgerRoot(input)) return undefined;
  return parsed.data;
}

function isoTimestampFromClock(clock: () => Date): string | undefined {
  try {
    const value = clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return undefined;
    const timestamp = value.toISOString();
    return isoTimestampSchema.safeParse(timestamp).success ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function generateReservationId(): string {
  const reservationId = `l3-${randomUUID()}`;
  if (!reservationIdSchema.safeParse(reservationId).success) fail('ledger_unavailable');
  return reservationId;
}

/**
 * Atomically reserve metadata-only L3 diagnostic capacity before any model
 * boundary dispatch.  This module deliberately has no route, credential,
 * environment, normal-config, network, or release-gate dependency.
 */
function reserveLiveGovernanceQuotaAtV1(
  input: ReserveLiveGovernanceQuotaInputV1,
  now: string,
): LiveGovernanceReservationResultV1 {
  if (!hasAbsoluteLedgerRoot(input)) return blocked('ledger_root_invalid');
  const parsed = parseReserveInput(input);
  if (!parsed) return blocked('reservation_invalid');
  try {
    const layout = prepareLedgerLayout(parsed.ledgerRoot);
    return withLedgerLock(layout, () => {
      const state = expireUnreconciledReservations(layout, loadLedgerState(layout), now);
      const reservationId = generateReservationId();
      if (state.reservations.has(reservationId)) {
        return blocked('reservation_duplicate');
      }
      if (activeReservations(state) >= profile.quotas.maxConcurrentRuns) {
        return blocked('concurrency_exhausted');
      }
      const buckets = utcBuckets(now);
      const dayUsage = bucketUsage(state, 'day', buckets.day);
      const monthUsage = bucketUsage(state, 'month', buckets.month);
      if (
        exceeds(addCounters(dayUsage, parsed.requested), profile.quotas.perDay) ||
        exceeds(addCounters(monthUsage, parsed.requested), profile.quotas.perMonth)
      ) {
        return blocked('quota_exhausted');
      }
      const record = buildReservationRecord({
        reservationId,
        routePolicyDigest: parsed.routePolicyDigest,
        reservedAt: now,
        leaseExpiresAt: addSeconds(
          now,
          parsed.leaseSeconds ?? profile.quotas.perRun.runWallClockSeconds,
        ),
        requested: parsed.requested,
        buckets,
      });
      appendLedgerRecordAtomically(layout, 'reservation', record);
      return { status: 'reserved', reservation: receipt(record) };
    });
  } catch (error) {
    return blocked(error instanceof LedgerFailureV1 ? error.reasonCode : 'ledger_unavailable');
  }
}

/**
 * Terminal reconciliation can only reduce a still-active reservation.  A late
 * or oversized report never releases capacity and is returned as blocked.
 */
function reconcileLiveGovernanceQuotaAtV1(
  input: ReconcileLiveGovernanceQuotaInputV1,
  now: string,
): LiveGovernanceReconciliationResultV1 {
  if (!hasAbsoluteLedgerRoot(input)) return blocked('ledger_root_invalid');
  const parsed = parseReconcileInput(input);
  if (!parsed) return blocked('reservation_invalid');
  try {
    const layout = prepareLedgerLayout(parsed.ledgerRoot);
    return withLedgerLock(layout, () => {
      const state = expireUnreconciledReservations(layout, loadLedgerState(layout), now);
      const reservation = state.reservations.get(parsed.reservationId);
      if (!reservation) return blocked('reservation_not_found');
      if (reservation.quotaLedgers.day.routePolicyDigest !== parsed.routePolicyDigest) {
        return blocked('reservation_not_found');
      }
      if (state.terminalEvents.has(reservation.reservationId))
        return blocked('reservation_not_active');
      const elapsedSeconds = elapsedReservationSeconds(reservation, now);
      if (elapsedSeconds === undefined) return blocked('reconciliation_time_invalid');
      const actual = {
        ...parsed.actual,
        runWallClockSeconds: Math.max(parsed.actual.runWallClockSeconds, elapsedSeconds),
      };
      if (exceeds(actual, reservation.quotaLedgers.day.reserved)) {
        return blocked('reconciliation_exceeds_reservation');
      }
      const reconciled = buildTerminalEvent(reservation, 'reconciled', actual, now);
      appendLedgerRecordAtomically(layout, 'terminal', reconciled);
      return { status: 'reconciled', reservation: receipt(reservation, reconciled) };
    });
  } catch (error) {
    return blocked(error instanceof LedgerFailureV1 ? error.reasonCode : 'ledger_unavailable');
  }
}

/**
 * Production reservation always reads the local ledger host clock.  There is
 * intentionally no caller timestamp field: callers cannot move a day/month
 * bucket, lease deadline, or wall-clock charge.
 */
export function reserveLiveGovernanceQuotaV1(
  input: ReserveLiveGovernanceQuotaInputV1,
): LiveGovernanceReservationResultV1 {
  const now = isoTimestampFromClock(() => new Date());
  return now ? reserveLiveGovernanceQuotaAtV1(input, now) : blocked('ledger_unavailable');
}

/** Production reconciliation uses the same ledger-owned local clock. */
export function reconcileLiveGovernanceQuotaV1(
  input: ReconcileLiveGovernanceQuotaInputV1,
): LiveGovernanceReconciliationResultV1 {
  const now = isoTimestampFromClock(() => new Date());
  return now ? reconcileLiveGovernanceQuotaAtV1(input, now) : blocked('ledger_unavailable');
}

/**
 * Deterministic clock injection is intentionally segregated to contract tests.
 * Real L3 callers must use the production functions above and cannot submit a
 * timestamp in a reservation or reconciliation payload.
 */
export function createLiveGovernanceLedgerTestHarnessV1(
  input: Readonly<{ now: () => Date }>,
): Readonly<{
  reserve: (reservation: ReserveLiveGovernanceQuotaInputV1) => LiveGovernanceReservationResultV1;
  reconcile: (
    reconciliation: ReconcileLiveGovernanceQuotaInputV1,
  ) => LiveGovernanceReconciliationResultV1;
}> {
  const testNow = (): string | undefined => isoTimestampFromClock(input.now);
  return {
    reserve: (reservation) => {
      const now = testNow();
      return now ? reserveLiveGovernanceQuotaAtV1(reservation, now) : blocked('ledger_unavailable');
    },
    reconcile: (reconciliation) => {
      const now = testNow();
      return now
        ? reconcileLiveGovernanceQuotaAtV1(reconciliation, now)
        : blocked('ledger_unavailable');
    },
  };
}

/** Exposed only for deterministic contract tests; it returns no ledger path. */
export function isLiveGovernanceLedgerRecordV1(
  value: unknown,
): value is LiveGovernanceReservationLedgerV1 {
  return liveGovernanceReservationLedgerV1Schema.safeParse(value).success;
}

/** Exposed only for deterministic contract tests; it returns no ledger path. */
export function isLiveGovernanceLedgerTerminalEventV1(
  value: unknown,
): value is LiveGovernanceLedgerTerminalEventV1 {
  return liveGovernanceLedgerTerminalEventV1Schema.safeParse(value).success;
}
