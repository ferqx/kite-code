import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { constants, Database } from '@kite-ai/agent/runtime-sqlite';
import {
  canonicalSerialize,
  type TraceDeliveryResult,
  type TraceEventBatch,
  type TraceEventView,
  traceBatchSchema,
} from '@kite-ai/trajectory';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  type TraceConsumerInspection,
  traceConsumerInspectionSchema,
} from '../../trace-extensions/consumer';
import { readTraceRow, readTraceRows } from '../../trace-extensions/sqlite-statements';
import type { OtelExportOutcome } from './exporter';
import {
  eventSpanIdentity,
  mappingAttributes,
  mappingVersion,
  type OtelSpanEnvelope,
  type OtelSpanIdentity,
} from './mapping';

export interface OtelGrantStamp {
  revision: string;
  epoch: string;
  active: boolean;
}
export interface OtelSpoolRow {
  key: string;
  taskId: string;
  revision: string;
  epoch: string;
  envelope: OtelSpanEnvelope;
  attempts: number;
  possibleDuplicate: boolean;
}
export interface OtelStoreOptions {
  path: string;
  installationId: string;
  endpoint: string;
  sampleRate?: number;
  maxBytes?: number;
  maxAcceptedEvents?: number;
}
/** Adapter-private dedup/open-span/spool. It never stores or mutates Runtime authority. */
export class OtelAdapterStore {
  readonly db: Database;
  readonly options: OtelStoreOptions;
  private readonly identityKey: string;
  private closed = false;
  constructor(options: OtelStoreOptions) {
    this.options = options;
    const parent = lstatSync(dirname(options.path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())))
    )
      throw Error('otel_store_access_denied');
    if (!existsSync(options.path)) writeFileSync(options.path, '', { flag: 'wx', mode: 0o600 });
    const file = lstatSync(options.path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      (process.platform !== 'win32' && (file.mode & 0o077) !== 0)
    )
      throw Error('otel_store_access_denied');
    if (
      options.sampleRate !== undefined &&
      (!Number.isFinite(options.sampleRate) || options.sampleRate < 0 || options.sampleRate > 1)
    )
      throw Error('otel_sampling_invalid');
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw Error('otel_endpoint_invalid');
    this.db = new Database(
      options.path,
      constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
    );
    try {
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL',
      );
      if (
        !readTraceRow(
          this.db,
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='integration'",
        )
      )
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE integration(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,mapping_version INTEGER NOT NULL,installation_id TEXT NOT NULL,endpoint TEXT NOT NULL,identity_key TEXT NOT NULL,revision TEXT NOT NULL,epoch TEXT NOT NULL,active INTEGER NOT NULL);
        CREATE TABLE task(id TEXT PRIMARY KEY,revision TEXT NOT NULL,epoch TEXT NOT NULL,active INTEGER NOT NULL);
        CREATE TABLE accepted(task_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(task_id,event_id));
        CREATE TABLE span_identity(identity TEXT PRIMARY KEY,reference TEXT NOT NULL,trace_id TEXT NOT NULL,span_id TEXT NOT NULL);
        CREATE TABLE open_span(task_id TEXT NOT NULL,identity TEXT NOT NULL,first_json TEXT NOT NULL,last_json TEXT NOT NULL,PRIMARY KEY(task_id,identity));
        CREATE TABLE spool(key TEXT PRIMARY KEY,task_id TEXT NOT NULL,revision TEXT NOT NULL,epoch TEXT NOT NULL,status TEXT NOT NULL,envelope_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,code TEXT,rejected_count INTEGER,possible_duplicate INTEGER NOT NULL DEFAULT 0);
        COMMIT;`);
      const integration = readTraceRow<{
        version: number;
        mapping_version: number;
        installation_id: string;
        endpoint: string;
        identity_key: string;
      }>(this.db, 'SELECT * FROM integration WHERE singleton=1');
      if (!integration)
        this.db.run('INSERT INTO integration VALUES(1,1,?,?,?,?,?,?,0)', [
          mappingVersion,
          options.installationId,
          endpoint.href,
          randomBytes(32).toString('hex'),
          '0',
          '0',
        ]);
      else if (
        integration.version !== 1 ||
        integration.mapping_version !== mappingVersion ||
        integration.installation_id !== options.installationId ||
        integration.endpoint !== endpoint.href
      )
        throw Error('otel_store_incompatible');
      this.identityKey = readTraceRow<{ identity_key: string }>(
        this.db,
        'SELECT identity_key FROM integration',
      )!.identity_key;
      // A previous process may have sent remotely. Retain the envelope and explicit duplicate risk.
      this.db.run(
        "UPDATE spool SET status='retry_wait',possible_duplicate=CASE WHEN attempts>0 THEN 1 ELSE possible_duplicate END WHERE status='sending'",
      );
    } catch (error) {
      this.db.close(true);
      throw error;
    }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  grant(): OtelGrantStamp {
    const row = readTraceRow<{ revision: string; epoch: string; active: number }>(
      this.db,
      'SELECT revision,epoch,active FROM integration',
    )!;
    return { revision: row.revision, epoch: row.epoch, active: row.active === 1 };
  }
  setGrant(stamp: OtelGrantStamp): void {
    this.transaction(() => {
      const old = this.grant();
      if (!stamp.active || old.revision !== stamp.revision || old.epoch !== stamp.epoch) {
        this.db.run('UPDATE task SET active=0');
        this.db.run(
          "UPDATE spool SET status=CASE WHEN status='sending' THEN 'unconfirmed' ELSE 'stopped' END,code='permission_revoked' WHERE status IN ('pending','sending','retry_wait')",
        );
        this.db.run('DELETE FROM open_span');
      }
      this.db.run('UPDATE integration SET revision=?,epoch=?,active=?', [
        stamp.revision,
        stamp.epoch,
        stamp.active ? 1 : 0,
      ]);
    });
  }
  private authorized(revision: string, epoch: string, taskId?: string): void {
    const now = this.grant();
    if (!now.active || now.revision !== revision || now.epoch !== epoch)
      throw Error('otel_permission_revoked');
    if (
      taskId &&
      !readTraceRow(
        this.db,
        'SELECT id FROM task WHERE id=? AND revision=? AND epoch=? AND active=1',
        taskId,
        revision,
        epoch,
      )
    )
      throw Error('otel_task_cancelled');
  }
  private identity(event: TraceEventView): OtelSpanIdentity | null {
    const mapped = eventSpanIdentity(event, this.identityKey);
    if (!mapped) return null;
    const reference =
      event.kind === 'run'
        ? `${event.scope.runOriginStoreRef}:${event.scope.runRef}`
        : `${event.scope.executionOriginStoreRef}:${event.scope.executionRef}`;
    this.db.run('INSERT OR IGNORE INTO span_identity VALUES(?,?,?,?)', [
      mapped.identity,
      reference,
      mapped.traceId,
      mapped.spanId,
    ]);
    return mapped;
  }
  consume(value: TraceEventBatch): TraceDeliveryResult {
    const batch = traceBatchSchema.parse(value);
    if (
      Buffer.byteLength(canonicalSerialize(batch)) > 512 * 1024 ||
      batch.partition.installationId !== this.options.installationId
    )
      throw Error('otel_delivery_invalid');
    let previous = BigInt(batch.fromCursor);
    if (
      previous > BigInt(batch.scannedThrough) ||
      BigInt(batch.scannedThrough) > BigInt(batch.upperCursor)
    )
      throw Error('otel_delivery_invalid');
    for (const event of batch.events) {
      if (
        BigInt(event.sequence) <= previous ||
        BigInt(event.sequence) > BigInt(batch.scannedThrough)
      )
        throw Error('otel_delivery_invalid');
      previous = BigInt(event.sequence);
    }
    const taskId =
      batch.partition.lane.kind === 'history'
        ? batch.partition.lane.exportId
        : `live:${batch.partition.subscriptionEpoch}`;
    return this.transaction(() => {
      this.authorized(batch.grantRevision, batch.partition.subscriptionEpoch);
      this.db.run('INSERT OR IGNORE INTO task VALUES(?,?,?,1)', [
        taskId,
        batch.grantRevision,
        batch.partition.subscriptionEpoch,
      ]);
      this.authorized(batch.grantRevision, batch.partition.subscriptionEpoch, taskId);
      for (const event of batch.events) {
        const hash = createHash('sha256').update(canonicalSerialize(event)).digest('hex');
        const prior = readTraceRow<{ digest: string }>(
          this.db,
          'SELECT digest FROM accepted WHERE task_id=? AND event_id=?',
          taskId,
          event.eventId,
        );
        if (prior) {
          if (prior.digest !== hash) throw Error('otel_event_conflict');
          continue;
        }
        let result = ['run', 'model', 'tool', 'job'].includes(event.kind)
          ? 'identity_unavailable'
          : 'not_span';
        const identity = this.identity(event);
        if (
          identity &&
          typeof event.occurredAt === 'number' &&
          Number.isSafeInteger(event.occurredAt) &&
          event.occurredAt >= 0
        ) {
          const old = readTraceRow<{ first_json: string }>(
            this.db,
            'SELECT first_json FROM open_span WHERE task_id=? AND identity=?',
            taskId,
            identity.identity,
          );
          const terminal = ['completed', 'failed', 'cancelled'].includes(event.phase);
          if (!terminal) {
            const starts =
              event.phase === 'planned' ||
              (event.kind === 'run' && event.sourceEventType === 'run.started');
            if (old || starts) {
              this.db.run(
                'INSERT INTO open_span VALUES(?,?,?,?) ON CONFLICT(task_id,identity) DO UPDATE SET last_json=excluded.last_json',
                [taskId, identity.identity, canonicalSerialize(event), canonicalSerialize(event)],
              );
              result = event.phase === 'outcome_unknown' ? 'open_unknown' : 'open';
            } else result = 'incomplete_prefix';
          } else if (old) {
            const first = JSON.parse(old.first_json) as TraceEventView;
            if (first.occurredAt === null || event.occurredAt < first.occurredAt)
              throw Error('otel_event_time_invalid');
            const parentRef =
              event.scope.parentExecutionRef && event.scope.parentExecutionOriginStoreRef
                ? `${event.scope.parentExecutionOriginStoreRef}:${event.scope.parentExecutionRef}`
                : event.kind !== 'run' && event.scope.runRef && event.scope.runOriginStoreRef
                  ? `${event.scope.runOriginStoreRef}:${event.scope.runRef}`
                  : undefined;
            const relation = parentRef ? this.spanIdentity(parentRef) : undefined;
            const links: OtelSpanIdentity[] =
              relation && relation.traceId !== identity.traceId ? [relation] : [];
            if (
              event.kind === 'model' &&
              event.attributes.previousExecutionRef &&
              event.attributes.previousExecutionOriginStoreRef
            ) {
              const previous = this.spanIdentity(
                `${event.attributes.previousExecutionOriginStoreRef}:${event.attributes.previousExecutionRef}`,
              );
              if (previous) links.push(previous);
            }
            const envelope: OtelSpanEnvelope = {
              ...identity,
              mappingVersion: 1,
              name: `kite.${event.kind}`,
              kind: event.kind === 'model' ? SpanKind.CLIENT : SpanKind.INTERNAL,
              startTime: first.occurredAt,
              endTime: event.occurredAt,
              attributes: mappingAttributes(first, event),
              status: event.phase === 'failed' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
              ...(relation && relation.traceId === identity.traceId ? { parent: relation } : {}),
              links,
            };
            const key = createHmac('sha256', this.identityKey)
              .update(
                canonicalSerialize([mappingVersion, taskId, identity.identity, event.eventId]),
              )
              .digest('hex');
            const sample = Number.parseInt(key.slice(0, 12), 16) / 0x1000000000000;
            const sampledOut = sample >= (this.options.sampleRate ?? 1);
            this.db.run(
              'INSERT OR IGNORE INTO spool(key,task_id,revision,epoch,status,envelope_json) VALUES(?,?,?,?,?,?)',
              [
                key,
                taskId,
                batch.grantRevision,
                batch.partition.subscriptionEpoch,
                sampledOut ? 'sampled_out' : 'pending',
                canonicalSerialize(envelope),
              ],
            );
            this.db.run('DELETE FROM open_span WHERE task_id=? AND identity=?', [
              taskId,
              identity.identity,
            ]);
            result = sampledOut ? 'sampled_out' : 'spooled';
          } else result = 'incomplete_prefix';
        } else if (identity) result = 'timing_unavailable';
        this.db.run('INSERT INTO accepted VALUES(?,?,?,?)', [taskId, event.eventId, hash, result]);
      }
      const cost = readTraceRow<{ bytes: number; count: number }>(
        this.db,
        `SELECT
        (SELECT COALESCE(SUM(length(first_json)+length(last_json)),0) FROM open_span)+
        (SELECT COALESCE(SUM(length(envelope_json)),0) FROM spool)+
        (SELECT COALESCE(SUM(length(event_id)+length(digest)+length(task_id)+length(result)+64),0) FROM accepted) AS bytes,
        (SELECT COUNT(*) FROM accepted) AS count`,
      )!;
      if (
        cost.bytes > (this.options.maxBytes ?? 64 * 1024 * 1024) ||
        cost.count > (this.options.maxAcceptedEvents ?? 100000)
      )
        throw Error('otel_capacity_exceeded');
      return {
        batchId: batch.batchId,
        leaseToken: batch.leaseToken,
        processGeneration: batch.processGeneration,
        subscriptionEpoch: batch.partition.subscriptionEpoch,
        acknowledgedEventIds: batch.events.map((event) => event.eventId),
        rejected: [],
      };
    });
  }
  private spanIdentity(reference: string) {
    return readTraceRow<OtelSpanIdentity>(
      this.db,
      'SELECT identity,trace_id AS traceId,span_id AS spanId FROM span_identity WHERE reference=? LIMIT 1',
      reference,
    );
  }
  next(now = Date.now()): OtelSpoolRow | null {
    return this.transaction(() => {
      const row = readTraceRow<{
        key: string;
        task_id: string;
        revision: string;
        epoch: string;
        envelope_json: string;
        attempts: number;
        possible_duplicate: number;
      }>(
        this.db,
        "SELECT * FROM spool WHERE status IN ('pending','retry_wait') AND next_at<=? ORDER BY rowid LIMIT 1",
        now,
      );
      if (!row) return null;
      this.authorized(row.revision, row.epoch, row.task_id);
      this.db.run("UPDATE spool SET status='sending' WHERE key=?", [row.key]);
      return {
        key: row.key,
        taskId: row.task_id,
        revision: row.revision,
        epoch: row.epoch,
        envelope: JSON.parse(row.envelope_json) as OtelSpanEnvelope,
        attempts: row.attempts,
        possibleDuplicate: row.possible_duplicate === 1,
      };
    });
  }
  admitSend(row: OtelSpoolRow): void {
    this.transaction(() => {
      this.authorized(row.revision, row.epoch, row.taskId);
      if (!readTraceRow(this.db, "SELECT key FROM spool WHERE key=? AND status='sending'", row.key))
        throw Error('otel_send_retired');
      const attempts = this.sendAttempts(row.key)!.attempts;
      if (attempts >= 8) throw Error('otel_retry_exhausted');
      this.db.run('UPDATE spool SET attempts=attempts+1 WHERE key=?', [row.key]);
    });
  }
  private sendAttempts(key: string) {
    return readTraceRow<{ attempts: number }>(
      this.db,
      'SELECT attempts FROM spool WHERE key=?',
      key,
    );
  }
  finish(
    row: OtelSpoolRow,
    outcome: OtelExportOutcome & { attempts: number; possibleDuplicate: boolean },
    now = Date.now(),
  ): void {
    this.transaction(() => {
      const actualAttempts = this.sendAttempts(row.key)?.attempts ?? 0;
      const blocked = outcome.kind === 'unconfirmed' && outcome.attempts === 0;
      const exhausted = actualAttempts >= 8 && (outcome.kind === 'transient' || blocked);
      const status = exhausted
        ? 'unconfirmed'
        : blocked
          ? 'retry_wait'
          : outcome.kind === 'full'
            ? 'accepted'
            : outcome.kind === 'partial'
              ? 'partial_unknown'
              : outcome.kind === 'permanent'
                ? 'rejected'
                : outcome.kind === 'transient'
                  ? 'retry_wait'
                  : 'unconfirmed';
      this.db.run(
        "UPDATE spool SET status=?,code=?,rejected_count=?,possible_duplicate=MAX(possible_duplicate,?),next_at=? WHERE key=? AND status='sending'",
        [
          status,
          exhausted ? 'retry_exhausted' : 'code' in outcome ? outcome.code : null,
          outcome.kind === 'partial' ? outcome.rejectedCount : null,
          outcome.possibleDuplicate ? 1 : 0,
          now + Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8)),
          row.key,
        ],
      );
    });
  }
  cancelTask(taskId: string): void {
    this.transaction(() => {
      this.db.run('UPDATE task SET active=0 WHERE id=?', [taskId]);
      this.db.run(
        "UPDATE spool SET status=CASE WHEN status='sending' THEN 'unconfirmed' ELSE 'stopped' END,code='task_cancelled' WHERE task_id=? AND status IN ('pending','sending','retry_wait')",
        [taskId],
      );
      this.db.run('DELETE FROM open_span WHERE task_id=?', [taskId]);
    });
  }
  inspect() {
    return readInspection(this.db);
  }
  close(): void {
    if (this.closed) return;
    this.db.close(true);
    this.closed = true;
  }
}

function readInspection(db: Database) {
  return {
    grant: (() => {
      const row = readTraceRow<{ revision: string; epoch: string; active: number }>(
        db,
        'SELECT revision,epoch,active FROM integration WHERE singleton=1',
      )!;
      return { ...row, active: row.active === 1 };
    })(),
    openSpans: readTraceRow<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM open_span')!
      .count,
    acceptedEvents: readTraceRow<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM accepted')!
      .count,
    unmappedEvents: readTraceRow<{
      notSpan: number;
      identityUnavailable: number;
      timingUnavailable: number;
      incompletePrefix: number;
    }>(
      db,
      `SELECT
        COALESCE(SUM(result='not_span'),0) AS notSpan,
        COALESCE(SUM(result='identity_unavailable'),0) AS identityUnavailable,
        COALESCE(SUM(result='timing_unavailable'),0) AS timingUnavailable,
        COALESCE(SUM(result='incomplete_prefix'),0) AS incompletePrefix FROM accepted`,
    )!,
    outgoingTotal: readTraceRow<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM spool')!
      .count,
    outgoingStates: readTraceRows<{ status: string; count: number }>(
      db,
      'SELECT status,COUNT(*) AS count FROM spool GROUP BY status ORDER BY status',
    ),
    outgoing: readTraceRows<{
      key: string;
      taskId: string;
      status: string;
      code: string | null;
      attempts: number;
      rejectedCount: number | null;
      possibleDuplicate: number;
    }>(
      db,
      'SELECT key,task_id AS taskId,status,code,attempts,rejected_count AS rejectedCount,possible_duplicate AS possibleDuplicate FROM spool ORDER BY rowid DESC LIMIT 200',
    ),
  };
}

/** Cold management inspection never creates state, recovers sending or starts a process. */
export function inspectOtelStore(options: {
  path: string;
  installationId: string;
  endpoint: string;
}): TraceConsumerInspection | null {
  if (!existsSync(options.path)) return null;
  const file = lstatSync(options.path),
    parent = lstatSync(dirname(options.path));
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    realpathSync.native(options.path) !== options.path ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((file.mode & 0o077) !== 0 ||
        (parent.mode & 0o077) !== 0 ||
        (process.getuid && (file.uid !== process.getuid() || parent.uid !== process.getuid()))))
  )
    throw Error('otel_store_access_denied');
  const db = new Database(
    options.path,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN');
    const identity = readTraceRow<{
      version: number;
      mapping_version: number;
      installation_id: string;
      endpoint: string;
    }>(
      db,
      'SELECT version,mapping_version,installation_id,endpoint FROM integration WHERE singleton=1',
    );
    if (
      identity?.version !== 1 ||
      identity.mapping_version !== mappingVersion ||
      identity.installation_id !== options.installationId ||
      identity.endpoint !== new URL(options.endpoint).href
    )
      throw Error('otel_store_incompatible');
    const inspection = traceConsumerInspectionSchema.parse(readInspection(db));
    db.exec('COMMIT');
    return inspection;
  } finally {
    db.close(true);
  }
}
