import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  canonicalSerialize,
  decimal64Schema,
  type TraceEventBatch,
  type TrajectoryEvidenceOpen,
  type TrajectoryEvidenceRef,
  type TrajectoryIntegrity,
  type TrajectoryPage,
  type TrajectoryReadRequest,
  type TrajectoryScope,
  traceBatchSchema,
  trajectoryScopeSchema,
  validateDeliveryResult,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import type { TraceEngineBundle } from './engine';
import { engineDigest } from './engine/assets';
import { projectTraceEvent, traceReference } from './projection';
import {
  sameScope,
  type TraceGrant,
  type TraceGrantState,
  TraceHostError,
  type TraceManifest,
  traceGrantSchema,
  traceManifestSchema,
} from './types';

interface InstallationRow {
  kind: 'third_party' | 'opentelemetry';
  id: string;
  digest: string;
  manifest_json: string;
  bundle_json: string;
  settings_json: string;
  identity_key: string;
  status: 'installed' | 'configured' | 'enabled' | 'disabled' | 'uninstalled';
  generation: string;
}
interface GrantRow {
  installation_id: string;
  revision: string;
  epoch: string;
  active: number;
  grant_json: string;
}
interface SubscriptionRow {
  id: string;
  installation_id: string;
  epoch: string;
  lane: 'live' | 'history';
  export_id: string | null;
  scope_json: string;
  kinds_json: string;
  from_cursor: string;
  upper_cursor: string;
  scan_cursor: string;
  ack_cursor: string;
  status: 'active' | 'paused' | 'cancelled' | 'revoked' | 'unavailable';
  integrity_json: string;
  content_mode: 'metadata' | 'authorized_evidence';
}
interface PendingRow {
  id: string;
  partition_id: string;
  event_id: string;
  sequence: string;
  event_json: string | null;
  bytes: number;
  state: 'pending' | 'acknowledged' | 'dead_letter' | 'terminated';
  attempts: number;
  retry_at: number;
  rejection: string | null;
}
interface LeaseRow {
  partition_id: string;
  token: string;
  generation: string;
  batch_json: string;
}
export interface ConsumerPartition {
  id: string;
  installationId: string;
  epoch: string;
  lane: 'live' | 'history';
  exportId?: string;
  scope: TrajectoryScope;
  fromCursor: string;
  upperCursor: string;
  sourceScanPosition: string;
  contiguousAcknowledgedPosition: string;
  status: SubscriptionRow['status'];
  integrity: TrajectoryIntegrity;
  pending: number;
  deadLetter: number;
  exhausted: boolean;
  deliveryComplete: boolean;
  contentMode: 'metadata' | 'authorized_evidence';
}
const initialIntegrity: TrajectoryIntegrity = {
  facts: 'unknown',
  identityConfidence: 'verified_origin',
  reasons: [],
};
const MAX_QUEUE_BYTES = 4 * 1024 * 1024,
  MAX_QUEUE_EVENTS = 4000;
const subset = (requested: readonly string[], available: readonly string[]) =>
  requested.every((value) => available.includes(value));
const increment = (value: string) => decimal64Schema.parse(String(BigInt(value) + 1n));
const schema = `
CREATE TABLE installation(id TEXT PRIMARY KEY,digest TEXT NOT NULL,manifest_json TEXT NOT NULL,bundle_json TEXT NOT NULL,settings_json TEXT NOT NULL,identity_key TEXT NOT NULL,status TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL);
CREATE TABLE trace_grant(installation_id TEXT PRIMARY KEY,revision TEXT NOT NULL,epoch TEXT NOT NULL,active INTEGER NOT NULL,grant_json TEXT NOT NULL);
CREATE TABLE subscription(id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,epoch TEXT NOT NULL,lane TEXT NOT NULL,export_id TEXT,scope_json TEXT NOT NULL,kinds_json TEXT NOT NULL,from_cursor TEXT NOT NULL,upper_cursor TEXT NOT NULL,scan_cursor TEXT NOT NULL,ack_cursor TEXT NOT NULL,status TEXT NOT NULL,integrity_json TEXT NOT NULL,content_mode TEXT NOT NULL);
CREATE TABLE pending(id TEXT PRIMARY KEY,partition_id TEXT NOT NULL,event_id TEXT NOT NULL,sequence TEXT NOT NULL,event_json TEXT,bytes INTEGER NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,retry_at INTEGER NOT NULL,rejection TEXT,UNIQUE(partition_id,event_id),UNIQUE(partition_id,sequence));
CREATE TABLE delivery_lease(partition_id TEXT PRIMARY KEY,token TEXT NOT NULL,generation TEXT NOT NULL,batch_json TEXT NOT NULL);
CREATE TABLE credential_binding(handle TEXT PRIMARY KEY,installation_id TEXT NOT NULL,origin TEXT NOT NULL,owner_digest TEXT NOT NULL,active INTEGER NOT NULL);
CREATE TABLE evidence_binding(partition_id TEXT NOT NULL,event_id TEXT NOT NULL,evidence_ref TEXT NOT NULL,version_ref TEXT NOT NULL,kind TEXT NOT NULL,source_request TEXT NOT NULL,PRIMARY KEY(partition_id,event_id,evidence_ref,version_ref));
CREATE TABLE scope_binding(installation_id TEXT NOT NULL,epoch TEXT NOT NULL,store_ref TEXT NOT NULL,session_ref TEXT NOT NULL,run_ref TEXT NOT NULL,execution_ref TEXT NOT NULL,scope_json TEXT NOT NULL,PRIMARY KEY(installation_id,epoch,store_ref,session_ref,run_ref,execution_ref));
CREATE TABLE read_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,installation_id TEXT NOT NULL,action TEXT NOT NULL,status TEXT NOT NULL,recorded_at INTEGER NOT NULL);
CREATE INDEX pending_partition ON pending(partition_id,state);
PRAGMA user_version=1;`;

/** Private retained ownership marker; only the finite code is safe for diagnostics. */
export class TraceConsumerCleanupError extends Error {
  readonly code = 'trace_consumer_cleanup_unconfirmed';
  constructor(originalError: unknown, cleanupError: unknown, database: Database) {
    super('trace_consumer_cleanup_unconfirmed', {
      cause: Object.freeze({ originalError, cleanupError, database }),
    });
  }
  toJSON() {
    return { code: this.code };
  }
}

/** Independent derived consumer state. No Runtime connection or business mutation is accepted. */
export class TraceConsumerStore {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const version = (this.db.query('PRAGMA user_version').get() as { user_version: number })
        .user_version;
      if (version === 0) {
        const tables = (
          this.db.query("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get() as {
            count: number;
          }
        ).count;
        if (tables) throw new TraceHostError('trace_consumer_schema_unknown');
        this.db.transaction(() => this.db.exec(schema))();
      } else if (version !== 1) throw new TraceHostError('trace_consumer_schema_unknown');
      // Previous callbacks cannot acquire ACK authority after process/service restart.
      this.db.exec('DELETE FROM delivery_lease');
    } catch (originalError) {
      try {
        this.db.close();
      } catch (cleanupError) {
        throw new TraceConsumerCleanupError(originalError, cleanupError, this.db);
      }
      throw originalError;
    }
  }

  close(): void {
    this.db.close();
  }
  private one<T>(sql: string, ...values: SQLQueryBindings[]): T | null {
    return this.db.query(sql).get(...values) as T | null;
  }
  private all<T>(sql: string, ...values: SQLQueryBindings[]): T[] {
    return this.db.query(sql).all(...values) as T[];
  }
  private run(sql: string, ...values: SQLQueryBindings[]): void {
    this.db.query(sql).run(...values);
  }
  private installation(id: string): InstallationRow {
    const row = this.one<InstallationRow>('SELECT * FROM installation WHERE id=?', id);
    if (!row || row.status === 'uninstalled')
      throw new TraceHostError('trace_installation_unavailable');
    return row;
  }
  private subscription(id: string): SubscriptionRow {
    const row = this.one<SubscriptionRow>('SELECT * FROM subscription WHERE id=?', id);
    if (!row) throw new TraceHostError('trace_partition_unavailable');
    return row;
  }
  grant(id: string): TraceGrantState {
    this.installation(id);
    const row = this.one<GrantRow>('SELECT * FROM trace_grant WHERE installation_id=?', id);
    if (!row) throw new TraceHostError('trace_grant_required');
    return {
      revision: row.revision,
      epoch: row.epoch,
      active: row.active === 1,
      grant: traceGrantSchema.parse(JSON.parse(row.grant_json)),
    };
  }
  inspectInstallation(id: string): {
    kind: InstallationRow['kind'];
    id: string;
    digest: string;
    manifest: TraceManifest;
    bundle: TraceEngineBundle;
    settings: Record<string, string | number | boolean>;
    status: InstallationRow['status'];
    generation: string;
  } {
    const row = this.installation(id);
    return {
      kind: row.kind,
      id: row.id,
      digest: row.digest,
      manifest: traceManifestSchema.parse(JSON.parse(row.manifest_json)),
      bundle: JSON.parse(row.bundle_json),
      settings: JSON.parse(row.settings_json),
      status: row.status,
      generation: row.generation,
    };
  }
  listInstallations(): { id: string; status: InstallationRow['status'] }[] {
    return this.all<{ id: string; status: InstallationRow['status'] }>(
      "SELECT id,status FROM installation WHERE status!='uninstalled'",
    );
  }
  createCredentialBinding(id: string, origin: string, ownerDigest: string): string {
    const installation = this.inspectInstallation(id);
    if (!installation.manifest.origins.includes(origin) || !/^[a-f0-9]{64}$/.test(ownerDigest))
      throw new TraceHostError('trace_credential_scope_denied');
    return this.db.transaction(() => {
      this.run(
        'UPDATE credential_binding SET active=-1 WHERE installation_id=? AND origin=?',
        id,
        origin,
      );
      const handle = randomUUID();
      this.run('INSERT INTO credential_binding VALUES(?,?,?,?,0)', handle, id, origin, ownerDigest);
      return handle;
    })();
  }
  activateCredential(handle: string): void {
    const row = this.one<{ installation_id: string; origin: string; active: number }>(
      'SELECT * FROM credential_binding WHERE handle=?',
      handle,
    );
    if (row?.active !== 0) throw new TraceHostError('trace_credential_unavailable');
    const latest = this.one<{ handle: string }>(
      'SELECT handle FROM credential_binding WHERE installation_id=? AND origin=? ORDER BY rowid DESC LIMIT 1',
      row.installation_id,
      row.origin,
    );
    if (latest?.handle !== handle) throw new TraceHostError('trace_credential_changed');
    this.run('UPDATE credential_binding SET active=1 WHERE handle=?', handle);
  }
  credential(
    id: string,
    handle: string,
  ): { handle: string; origin: string; ownerDigest: string; active: boolean } {
    this.installation(id);
    const row = this.one<{ handle: string; origin: string; owner_digest: string; active: number }>(
      'SELECT * FROM credential_binding WHERE installation_id=? AND handle=?',
      id,
      handle,
    );
    if (!row) throw new TraceHostError('trace_credential_unavailable');
    return {
      handle: row.handle,
      origin: row.origin,
      ownerDigest: row.owner_digest,
      active: row.active === 1,
    };
  }
  revokeCredential(id: string, handle: string): void {
    this.credential(id, handle);
    this.run(
      'UPDATE credential_binding SET active=-1 WHERE installation_id=? AND handle=?',
      id,
      handle,
    );
  }
  credentialHandles(id: string): { handle: string; origin: string; active: boolean }[] {
    this.installation(id);
    return this.all<{ handle: string; origin: string; active: number }>(
      'SELECT handle,origin,active FROM credential_binding WHERE installation_id=?',
      id,
    ).map((row) => ({ ...row, active: row.active === 1 }));
  }
  audit(
    id: string,
    action:
      | 'evidence_open'
      | 'evidence_chunk'
      | 'evidence_close'
      | 'http_send'
      | 'credential_resolve',
    status: 'allowed' | 'denied' | 'unknown' | 'closed',
  ): void {
    this.db.transaction(() => {
      this.run(
        'INSERT INTO read_audit(installation_id,action,status,recorded_at) VALUES(?,?,?,?)',
        id,
        action,
        status,
        Date.now(),
      );
      this.run(
        'DELETE FROM read_audit WHERE id <= (SELECT COALESCE(max(id),0)-1000 FROM read_audit)',
      );
    })();
  }
  assertAuthorization(
    id: string,
    revision: string,
    epoch: string,
    generation?: string,
  ): TraceGrantState {
    const installation = this.installation(id),
      grant = this.grant(id);
    if (
      installation.status !== 'enabled' ||
      !grant.active ||
      grant.revision !== revision ||
      grant.epoch !== epoch ||
      (generation !== undefined && generation !== installation.generation)
    )
      throw new TraceHostError('trace_permission_revoked');
    return grant;
  }
  resolveGrantedScope(
    id: string,
    refs: { storeRef: string; sessionRef: string; runRef?: string; executionRef?: string },
  ): TrajectoryScope {
    const installation = this.installation(id),
      grant = this.grant(id);
    const scope = grant.grant.scopes.find(
      (value) =>
        traceReference(installation.identity_key, 'store', value.storeId) === refs.storeRef &&
        traceReference(installation.identity_key, 'session', value.sessionId, value.storeId) ===
          refs.sessionRef &&
        (value.runId
          ? traceReference(installation.identity_key, 'run', value.runId, value.storeId)
          : undefined) === refs.runRef &&
        (value.executionId
          ? traceReference(installation.identity_key, 'execution', value.executionId, value.storeId)
          : undefined) === refs.executionRef,
    );
    if (!grant.active) throw new TraceHostError('trace_scope_denied');
    if (scope) return scope;
    const binding = this.one<{ scope_json: string }>(
      'SELECT scope_json FROM scope_binding WHERE installation_id=? AND epoch=? AND store_ref=? AND session_ref=? AND run_ref=? AND execution_ref=?',
      id,
      grant.epoch,
      refs.storeRef,
      refs.sessionRef,
      refs.runRef ?? '',
      refs.executionRef ?? '',
    );
    if (!binding) throw new TraceHostError('trace_scope_denied');
    const resolved = trajectoryScopeSchema.parse(JSON.parse(binding.scope_json));
    if (!sameScope(grant.grant, resolved)) throw new TraceHostError('trace_scope_denied');
    return resolved;
  }
  install(manifestValue: unknown, bundle: TraceEngineBundle): string {
    const manifest = traceManifestSchema.parse(manifestValue);
    if (
      bundle.apiVersion !== 1 ||
      Buffer.byteLength(bundle.source) > 512 * 1024 ||
      bundle.sha256 !== engineDigest(bundle.source)
    )
      throw new TraceHostError('trace_bundle_invalid');
    const id = randomUUID();
    this.run(
      'INSERT INTO installation VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      bundle.sha256,
      canonicalSerialize(manifest),
      canonicalSerialize(bundle),
      '{}',
      randomBytes(32).toString('hex'),
      'installed',
      '0',
      'third_party',
    );
    return id;
  }
  installTrusted(kind: 'opentelemetry', manifest: unknown, bundle: TraceEngineBundle): string {
    const id = this.install(manifest, bundle);
    this.run('UPDATE installation SET kind=? WHERE id=?', kind, id);
    return id;
  }
  installTrustedConfigured(
    kind: 'opentelemetry',
    manifest: unknown,
    bundle: TraceEngineBundle,
    settings: Record<string, string | number | boolean>,
  ): string {
    return this.db.transaction(() => {
      const id = this.installTrusted(kind, manifest, bundle);
      this.configure(id, settings);
      return id;
    })();
  }
  assertTaskActive(id: string, epoch: string, taskId: string): void {
    const liveTask = `live:${id}:${epoch}`;
    const row =
      taskId === liveTask || taskId === `live:${epoch}`
        ? this.one<SubscriptionRow>(
            "SELECT * FROM subscription WHERE installation_id=? AND epoch=? AND lane='live' AND status IN('active','unavailable') LIMIT 1",
            id,
            epoch,
          )
        : this.one<SubscriptionRow>(
            "SELECT * FROM subscription WHERE installation_id=? AND epoch=? AND lane='history' AND export_id=? AND status IN('active','unavailable')",
            id,
            epoch,
            taskId,
          );
    if (!row) throw new TraceHostError('trace_task_inactive');
  }
  configure(id: string, value: Record<string, string | number | boolean>): void {
    const manifest = this.inspectInstallation(id).manifest;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) =>
          !Object.hasOwn(manifest.settings, key) ||
          typeof value[key] !== manifest.settings[key] ||
          (typeof value[key] === 'string' && Buffer.byteLength(value[key]) > 2048) ||
          (typeof value[key] === 'number' && !Number.isFinite(value[key])),
      ) ||
      Buffer.byteLength(canonicalSerialize(value)) > 4096
    )
      throw new TraceHostError('trace_settings_invalid');
    this.run(
      "UPDATE installation SET settings_json=?,status=CASE WHEN status='installed' THEN 'configured' ELSE status END WHERE id=?",
      canonicalSerialize(value),
      id,
    );
  }
  private terminateSubscriptions(id: string, status: 'revoked' | 'cancelled'): void {
    this.run(
      'DELETE FROM delivery_lease WHERE partition_id IN(SELECT id FROM subscription WHERE installation_id=?)',
      id,
    );
    this.run(
      "UPDATE pending SET state='terminated',event_json=NULL,bytes=0 WHERE state!='acknowledged' AND partition_id IN(SELECT id FROM subscription WHERE installation_id=?)",
      id,
    );
    this.run(
      "UPDATE subscription SET status=? WHERE installation_id=? AND status IN('active','paused','unavailable')",
      status,
      id,
    );
  }
  authorize(id: string, value: unknown): TraceGrantState {
    const installation = this.inspectInstallation(id),
      grant = traceGrantSchema.parse(value);
    if (
      (grant.allowHistory && !installation.manifest.history) ||
      !subset(grant.eventKinds, installation.manifest.eventKinds) ||
      !subset(grant.evidenceKinds, installation.manifest.evidenceKinds) ||
      !subset(grant.origins, installation.manifest.origins) ||
      (grant.credentialHandles ?? []).some((handle) => {
        const binding = this.credential(id, handle);
        return !binding.active || !grant.origins.includes(binding.origin);
      })
    )
      throw new TraceHostError('trace_manifest_permission_denied');
    this.db.transaction(() => {
      const previous = this.one<GrantRow>('SELECT * FROM trace_grant WHERE installation_id=?', id);
      this.terminateSubscriptions(id, 'revoked');
      this.run(
        'INSERT OR REPLACE INTO trace_grant VALUES(?,?,?,?,?)',
        id,
        increment(previous?.revision ?? '0'),
        increment(previous?.epoch ?? '0'),
        1,
        canonicalSerialize(grant),
      );
      this.run(
        "UPDATE installation SET status='configured',generation=? WHERE id=?",
        increment(installation.generation),
        id,
      );
    })();
    return this.grant(id);
  }
  revoke(id: string): void {
    const installation = this.installation(id);
    this.db.transaction(() => {
      this.terminateSubscriptions(id, 'revoked');
      const previous = this.one<GrantRow>('SELECT * FROM trace_grant WHERE installation_id=?', id);
      if (previous)
        this.run(
          'UPDATE trace_grant SET active=0,revision=?,epoch=? WHERE installation_id=?',
          increment(previous.revision),
          increment(previous.epoch),
          id,
        );
      this.run(
        "UPDATE installation SET status='disabled',generation=? WHERE id=?",
        increment(installation.generation),
        id,
      );
    })();
  }
  disable(id: string): void {
    const row = this.installation(id);
    this.db.transaction(() => {
      this.run(
        "UPDATE installation SET status='disabled',generation=? WHERE id=?",
        increment(row.generation),
        id,
      );
      this.run(
        'DELETE FROM delivery_lease WHERE partition_id IN(SELECT id FROM subscription WHERE installation_id=?)',
        id,
      );
    })();
  }
  enable(id: string): void {
    const grant = this.grant(id);
    if (!grant.active) throw new TraceHostError('trace_permission_revoked');
    this.db.transaction(() => {
      this.run("UPDATE installation SET status='enabled' WHERE id=?", id);
    })();
  }
  enablePartitions(id: string, snapshots: { scope: TrajectoryScope; upper: string }[]): void {
    this.db.transaction(() => {
      this.enable(id);
      const grant = this.grant(id);
      for (const item of snapshots)
        this.createPartition(id, item.scope, grant.grant.eventKinds, item.upper);
    })();
  }
  nextGeneration(id: string): string {
    const row = this.installation(id),
      next = increment(row.generation);
    this.db.transaction(() => {
      this.run('UPDATE installation SET generation=? WHERE id=?', next, id);
      this.run(
        'DELETE FROM delivery_lease WHERE partition_id IN(SELECT id FROM subscription WHERE installation_id=?)',
        id,
      );
    })();
    return next;
  }
  update(id: string, manifest: unknown, bundle: TraceEngineBundle): void {
    const checked = traceManifestSchema.parse(manifest);
    if (
      bundle.apiVersion !== 1 ||
      Buffer.byteLength(bundle.source) > 512 * 1024 ||
      bundle.sha256 !== engineDigest(bundle.source)
    )
      throw new TraceHostError('trace_bundle_invalid');
    this.db.transaction(() => {
      this.revoke(id);
      this.run(
        "UPDATE installation SET digest=?,manifest_json=?,bundle_json=?,settings_json='{}',status='installed' WHERE id=?",
        bundle.sha256,
        canonicalSerialize(checked),
        canonicalSerialize(bundle),
        id,
      );
    })();
  }
  uninstall(id: string): void {
    this.db.transaction(() => {
      this.revoke(id);
      this.run("UPDATE installation SET status='uninstalled' WHERE id=?", id);
    })();
  }
  private checkActive(
    row: SubscriptionRow,
    copiedDelivery = false,
  ): { installation: InstallationRow; grant: TraceGrantState } {
    const installation = this.installation(row.installation_id),
      grant = this.grant(row.installation_id);
    if (
      installation.status !== 'enabled' ||
      !grant.active ||
      grant.epoch !== row.epoch ||
      (row.status !== 'active' && !(copiedDelivery && row.status === 'unavailable'))
    )
      throw new TraceHostError('trace_permission_revoked');
    if (!sameScope(grant.grant, JSON.parse(row.scope_json)))
      throw new TraceHostError('trace_scope_denied');
    return { installation, grant };
  }
  createPartition(
    id: string,
    scope: TrajectoryScope,
    kinds: TraceGrant['eventKinds'],
    upper: string,
    options: {
      exportId?: string;
      fromCursor?: string;
      contentMode?: 'metadata' | 'authorized_evidence';
    } = {},
  ): string {
    scope = trajectoryScopeSchema.omit({ eventKinds: true }).parse(scope);
    const grant = this.grant(id);
    decimal64Schema.parse(upper);
    const from = decimal64Schema.parse(options.fromCursor ?? (options.exportId ? '0' : upper));
    if (
      !grant.active ||
      (options.exportId && !grant.grant.allowHistory) ||
      (options.contentMode === 'authorized_evidence' && !grant.grant.evidenceKinds.length) ||
      !sameScope(grant.grant, scope) ||
      !subset(kinds, grant.grant.eventKinds) ||
      BigInt(from) > BigInt(upper)
    )
      throw new TraceHostError('trace_scope_denied');
    const lane = options.exportId ? 'history' : 'live';
    const key = engineDigest(
      canonicalSerialize([id, scope, grant.epoch, lane, options.exportId ?? null]),
    );
    if (this.one('SELECT id FROM subscription WHERE id=?', key)) return key;
    const active = this.one<{ count: number }>(
      "SELECT count(*) AS count FROM subscription WHERE installation_id=? AND status IN('active','paused')",
      id,
    )!.count;
    if (active >= 4) throw new TraceHostError('trace_partition_limit');
    this.run(
      'INSERT INTO subscription VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      key,
      id,
      grant.epoch,
      lane,
      options.exportId ?? null,
      canonicalSerialize(scope),
      canonicalSerialize(kinds),
      from,
      upper,
      from,
      from,
      'active',
      canonicalSerialize(initialIntegrity),
      options.contentMode ??
        (options.exportId || !grant.grant.evidenceKinds.length
          ? 'metadata'
          : 'authorized_evidence'),
    );
    return key;
  }
  requestFor(id: string): TrajectoryReadRequest {
    const row = this.subscription(id);
    this.checkActive(row);
    return {
      ...JSON.parse(row.scope_json),
      eventKinds: JSON.parse(row.kinds_json),
      afterCursor: row.scan_cursor,
      upperCursor: row.upper_cursor,
      limit: 200,
    };
  }
  extendLiveWindow(id: string, upper: string): void {
    const row = this.subscription(id);
    this.checkActive(row);
    decimal64Schema.parse(upper);
    if (
      row.lane !== 'live' ||
      row.scan_cursor !== row.upper_cursor ||
      BigInt(upper) < BigInt(row.upper_cursor)
    )
      throw new TraceHostError('trace_window_invalid');
    this.run('UPDATE subscription SET upper_cursor=? WHERE id=?', upper, id);
  }
  enqueuePage(id: string, value: TrajectoryPage): { accepted: boolean; queued: number } {
    return this.db.transaction(() => {
      const row = this.subscription(id),
        { installation, grant } = this.checkActive(row);
      const page = verifyTrajectoryPage(value, this.requestFor(id));
      const projectedGrant =
        row.content_mode === 'metadata' ? { ...grant.grant, evidenceKinds: [] } : grant.grant;
      const views = page.events
        .filter((event) => event.kind !== 'unknown' && grant.grant.eventKinds.includes(event.kind))
        .map((event) =>
          projectTraceEvent(event, projectedGrant, installation.identity_key, page.storeId),
        );
      const encoded = views.map((event) => ({ event, json: canonicalSerialize(event) }));
      const queue = this.one<{ count: number; bytes: number }>(
        "SELECT count(*) AS count,COALESCE(sum(bytes),0) AS bytes FROM pending WHERE state IN('pending','dead_letter') AND partition_id IN(SELECT id FROM subscription WHERE installation_id=?)",
        row.installation_id,
      )!;
      const bytes = encoded.reduce((total, item) => total + Buffer.byteLength(item.json), 0);
      if (queue.count + encoded.length > MAX_QUEUE_EVENTS || queue.bytes + bytes > MAX_QUEUE_BYTES)
        return { accepted: false, queued: 0 };
      for (const item of encoded)
        this.run(
          "INSERT INTO pending VALUES(?,?,?,?,?,?, 'pending',0,0,NULL)",
          randomUUID(),
          id,
          item.event.eventId,
          item.event.sequence,
          item.json,
          Buffer.byteLength(item.json),
        );
      for (const event of page.events) {
        const view = views.find((item) => item.eventId === event.eventId);
        if (!view) continue;
        const combinations = [
          {},
          ...(event.runId ? [{ runId: event.runId }] : []),
          ...(event.executionId ? [{ executionId: event.executionId }] : []),
          ...(event.runId && event.executionId
            ? [{ runId: event.runId, executionId: event.executionId }]
            : []),
        ];
        for (const selection of combinations) {
          const rawScope = { storeId: page.storeId, sessionId: page.sessionId, ...selection };
          this.run(
            'INSERT OR REPLACE INTO scope_binding VALUES(?,?,?,?,?,?,?)',
            row.installation_id,
            row.epoch,
            view.scope.storeRef,
            view.scope.sessionRef,
            'runId' in selection ? view.scope.runRef! : '',
            'executionId' in selection ? view.scope.executionRef! : '',
            canonicalSerialize(rawScope),
          );
        }
        for (const reference of event.evidenceRefs) {
          const evidenceRef = traceReference(
            installation.identity_key,
            'evidence',
            reference.evidenceId,
            page.storeId,
          );
          const versionRef = traceReference(
            installation.identity_key,
            'evidence-version',
            reference.contentVersion,
            page.storeId,
          );
          if (
            !view.evidenceRefs.some(
              (item) => item.evidenceId === evidenceRef && item.contentVersion === versionRef,
            )
          )
            continue;
          this.run(
            'INSERT OR REPLACE INTO evidence_binding VALUES(?,?,?,?,?,?)',
            id,
            event.eventId,
            evidenceRef,
            versionRef,
            reference.kind,
            canonicalSerialize({
              storeId: page.storeId,
              sessionId: page.sessionId,
              upperCursor: page.upperCursor,
              atCursor: event.sequence,
              eventId: event.eventId,
              evidenceId: reference.evidenceId,
              contentVersion: reference.contentVersion,
            }),
          );
        }
      }
      const integrity =
        row.lane === 'history' && BigInt(row.from_cursor) > 0n
          ? {
              ...page.integrity,
              facts: 'partial',
              reasons: [...new Set([...page.integrity.reasons, 'incomplete_prefix'])],
            }
          : page.integrity;
      this.run(
        'UPDATE subscription SET scan_cursor=?,integrity_json=? WHERE id=?',
        page.scannedThrough,
        canonicalSerialize(integrity),
        id,
      );
      this.advanceAcknowledged(id);
      return { accepted: true, queued: encoded.length };
    })();
  }
  private advanceAcknowledged(id: string): void {
    const row = this.subscription(id);
    const first = this.one<PendingRow>(
      "SELECT * FROM pending WHERE partition_id=? AND state!='acknowledged' ORDER BY length(sequence),sequence LIMIT 1",
      id,
    );
    const position = first ? String(BigInt(first.sequence) - 1n) : row.scan_cursor;
    if (BigInt(position) >= BigInt(row.ack_cursor))
      this.run('UPDATE subscription SET ack_cursor=? WHERE id=?', position, id);
    for (const item of this.all<PendingRow>(
      "SELECT * FROM pending WHERE partition_id=? AND state='acknowledged'",
      id,
    ))
      if (BigInt(item.sequence) <= BigInt(position))
        this.run('DELETE FROM pending WHERE id=?', item.id);
  }
  lease(id: string, generation: string, now = Date.now()): TraceEventBatch | null {
    return this.db.transaction(() => {
      const row = this.subscription(id),
        { installation, grant } = this.checkActive(row, true);
      if (generation !== installation.generation)
        throw new TraceHostError('trace_generation_stale');
      if (this.one('SELECT token FROM delivery_lease WHERE partition_id=?', id)) return null;
      if (this.one("SELECT id FROM pending WHERE partition_id=? AND state='dead_letter'", id))
        return null;
      const pending = this.all<PendingRow>(
        "SELECT * FROM pending WHERE partition_id=? AND state='pending' ORDER BY length(sequence),sequence LIMIT 200",
        id,
      );
      if (!pending.length || pending.some((item) => item.retry_at > now)) return null;
      const scope = JSON.parse(row.scope_json) as TrajectoryScope;
      const events = [];
      let bytes = 2048;
      for (const item of pending) {
        if (bytes + item.bytes > 512 * 1024) {
          if (!events.length) throw new TraceHostError('trace_event_oversized');
          break;
        }
        bytes += item.bytes;
        events.push(JSON.parse(item.event_json!));
      }
      const batch = traceBatchSchema.parse({
        source: row.lane,
        batchId: randomUUID(),
        leaseToken: randomUUID(),
        processGeneration: generation,
        partition: {
          installationId: row.installation_id,
          storeRef: traceReference(installation.identity_key, 'store', scope.storeId),
          sessionRef: traceReference(
            installation.identity_key,
            'session',
            scope.sessionId,
            scope.storeId,
          ),
          subscriptionEpoch: row.epoch,
          lane:
            row.lane === 'live' ? { kind: 'live' } : { kind: 'history', exportId: row.export_id },
        },
        grantRevision: grant.revision,
        filterRevision: row.epoch,
        upperCursor: row.upper_cursor,
        fromCursor: row.from_cursor,
        scannedThrough: row.scan_cursor,
        events,
        integrity: JSON.parse(row.integrity_json),
      });
      this.run(
        'INSERT INTO delivery_lease VALUES(?,?,?,?)',
        id,
        batch.leaseToken,
        generation,
        canonicalSerialize(batch),
      );
      return batch;
    })();
  }
  acknowledge(id: string, response: unknown, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.subscription(id),
        { installation, grant } = this.checkActive(row, true);
      const lease = this.one<LeaseRow>('SELECT * FROM delivery_lease WHERE partition_id=?', id);
      if (!lease || lease.generation !== installation.generation)
        throw new TraceHostError('trace_lease_stale');
      const batch = traceBatchSchema.parse(JSON.parse(lease.batch_json));
      if (
        batch.grantRevision !== grant.revision ||
        batch.partition.subscriptionEpoch !== grant.epoch
      )
        throw new TraceHostError('trace_lease_stale');
      const result = validateDeliveryResult(response, batch);
      const acknowledged = new Set(result.acknowledgedEventIds);
      for (const event of batch.events) {
        const item = this.one<PendingRow>(
          'SELECT * FROM pending WHERE partition_id=? AND event_id=?',
          id,
          event.eventId,
        )!;
        if (acknowledged.has(event.eventId))
          this.run(
            "UPDATE pending SET state='acknowledged',event_json=NULL,bytes=0 WHERE id=?",
            item.id,
          );
        else {
          const attempts = item.attempts + 1,
            reason =
              result.rejected.find((rejection) => rejection.eventId === event.eventId)?.reason ??
              'delivery_failed';
          const delay = Math.min(
            300000,
            Math.round(1000 * 2 ** (attempts - 1) * (0.8 + Math.random() * 0.4)),
          );
          this.run(
            'UPDATE pending SET state=?,attempts=?,retry_at=?,rejection=? WHERE id=?',
            attempts >= 8 ? 'dead_letter' : 'pending',
            attempts,
            now + delay,
            reason,
            item.id,
          );
        }
      }
      this.run('DELETE FROM delivery_lease WHERE partition_id=?', id);
      this.advanceAcknowledged(id);
    })();
  }
  deliveryFailed(id: string, now = Date.now()): void {
    const lease = this.one<LeaseRow>('SELECT * FROM delivery_lease WHERE partition_id=?', id);
    if (!lease) throw new TraceHostError('trace_lease_stale');
    const batch = traceBatchSchema.parse(JSON.parse(lease.batch_json));
    this.acknowledge(
      id,
      {
        batchId: batch.batchId,
        leaseToken: batch.leaseToken,
        processGeneration: batch.processGeneration,
        subscriptionEpoch: batch.partition.subscriptionEpoch,
        acknowledgedEventIds: [],
        rejected: [],
      },
      now,
    );
  }
  retryDeadLetter(id: string): void {
    const row = this.subscription(id);
    this.checkActive(row, true);
    this.run(
      "UPDATE pending SET state='pending',attempts=0,retry_at=0,rejection=NULL WHERE partition_id=? AND state='dead_letter'",
      id,
    );
  }
  cancelExport(id: string): void {
    const row = this.subscription(id);
    if (row.lane !== 'history') throw new TraceHostError('trace_history_required');
    if (row.status === 'cancelled' || row.status === 'revoked') return;
    this.db.transaction(() => {
      this.run("UPDATE subscription SET status='cancelled' WHERE id=?", id);
      this.run('DELETE FROM delivery_lease WHERE partition_id=?', id);
      this.run(
        "UPDATE pending SET state='terminated',event_json=NULL,bytes=0 WHERE partition_id=? AND state!='acknowledged'",
        id,
      );
    })();
  }
  pauseExport(id: string): void {
    const row = this.subscription(id);
    this.checkActive(row, true);
    if (row.lane !== 'history') throw new TraceHostError('trace_history_required');
    this.db.transaction(() => {
      this.run("UPDATE subscription SET status='paused' WHERE id=?", id);
      this.run('DELETE FROM delivery_lease WHERE partition_id=?', id);
    })();
  }
  resumeExport(id: string): void {
    const row = this.subscription(id),
      grant = this.grant(row.installation_id),
      installation = this.installation(row.installation_id);
    if (
      row.lane !== 'history' ||
      row.status !== 'paused' ||
      !grant.active ||
      grant.epoch !== row.epoch ||
      installation.status !== 'enabled'
    )
      throw new TraceHostError('trace_history_resume_denied');
    this.run("UPDATE subscription SET status='active' WHERE id=?", id);
  }
  markSourceUnavailable(id: string): void {
    const row = this.subscription(id);
    this.checkActive(row);
    this.run(
      "UPDATE subscription SET status='unavailable',integrity_json=? WHERE id=?",
      canonicalSerialize({
        ...JSON.parse(row.integrity_json),
        facts: 'partial',
        reasons: ['source_unavailable'],
      }),
      id,
    );
  }
  evidenceForBatch(
    id: string,
    revision: string,
    epoch: string,
    generation: string,
    batchId: string,
    eventId: string,
    evidenceRef: string,
    versionRef: string,
  ): { source: TrajectoryEvidenceOpen; kind: TrajectoryEvidenceRef['kind']; partitionId: string } {
    const grant = this.assertAuthorization(id, revision, epoch, generation);
    for (const lease of this.all<LeaseRow>(
      'SELECT * FROM delivery_lease WHERE partition_id IN(SELECT id FROM subscription WHERE installation_id=? AND epoch=?)',
      id,
      epoch,
    )) {
      const batch = traceBatchSchema.parse(JSON.parse(lease.batch_json));
      if (batch.batchId !== batchId || batch.processGeneration !== generation) continue;
      const partition = this.inspectPartition(lease.partition_id);
      if (partition.contentMode !== 'authorized_evidence' || partition.status !== 'active')
        throw new TraceHostError('trace_evidence_denied');
      const event = batch.events.find((item) => item.eventId === eventId);
      const ref = event?.evidenceRefs.find(
        (item) => item.evidenceId === evidenceRef && item.contentVersion === versionRef,
      );
      if (!ref || !grant.grant.evidenceKinds.includes(ref.kind))
        throw new TraceHostError('trace_evidence_denied');
      const binding = this.one<{ source_request: string; kind: TrajectoryEvidenceRef['kind'] }>(
        'SELECT source_request,kind FROM evidence_binding WHERE partition_id=? AND event_id=? AND evidence_ref=? AND version_ref=?',
        lease.partition_id,
        eventId,
        evidenceRef,
        versionRef,
      );
      if (!binding) throw new TraceHostError('trace_evidence_unavailable');
      return {
        source: JSON.parse(binding.source_request),
        kind: binding.kind,
        partitionId: lease.partition_id,
      };
    }
    throw new TraceHostError('trace_lease_stale');
  }
  inspectPartition(id: string): ConsumerPartition {
    const row = this.subscription(id);
    const pending = this.one<{ count: number }>(
      "SELECT count(*) AS count FROM pending WHERE partition_id=? AND state='pending'",
      id,
    )!.count;
    const deadLetter = this.one<{ count: number }>(
      "SELECT count(*) AS count FROM pending WHERE partition_id=? AND state='dead_letter'",
      id,
    )!.count;
    return {
      id,
      installationId: row.installation_id,
      epoch: row.epoch,
      lane: row.lane,
      ...(row.export_id ? { exportId: row.export_id } : {}),
      scope: JSON.parse(row.scope_json),
      fromCursor: row.from_cursor,
      upperCursor: row.upper_cursor,
      sourceScanPosition: row.scan_cursor,
      contiguousAcknowledgedPosition: row.ack_cursor,
      status: row.status,
      integrity: JSON.parse(row.integrity_json),
      pending,
      deadLetter,
      exhausted: row.scan_cursor === row.upper_cursor,
      deliveryComplete:
        row.status === 'active' &&
        row.scan_cursor === row.upper_cursor &&
        pending === 0 &&
        deadLetter === 0,
      contentMode: row.content_mode,
    };
  }
  listPartitions(id: string): ConsumerPartition[] {
    this.installation(id);
    return this.all<{ id: string }>('SELECT id FROM subscription WHERE installation_id=?', id).map(
      (row) => this.inspectPartition(row.id),
    );
  }
  deadLetters(
    id: string,
  ): { eventId: string; sequence: string; attempts: number; reason: string }[] {
    this.subscription(id);
    return this.all<PendingRow>(
      "SELECT * FROM pending WHERE partition_id=? AND state='dead_letter' ORDER BY length(sequence),sequence LIMIT 200",
      id,
    ).map((item) => ({
      eventId: item.event_id,
      sequence: item.sequence,
      attempts: item.attempts,
      reason: item.rejection ?? 'delivery_failed',
    }));
  }
}
