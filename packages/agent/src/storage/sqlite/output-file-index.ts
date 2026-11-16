import { canonicalJson } from '../../json';
import type { Json } from '../types';
import type { SqliteOperations } from './operations';
import { projectOutputDeliveries } from './output-file-projection';

const namespace = 'builtin.files';
const headKey = 'output-index/state';
const indexPrefix = 'output-index/';
const contentType = 'builtin.files.output-index';
const sourceEvents = `(type='extension.record_updated' AND
  (object_id LIKE 'builtin.files/delivery/%' OR object_id LIKE 'builtin.files/collection/%'))
  OR type IN ('run.started','run.finished','run.interrupted','session.forked')`;
type Changes = { prefixes: Set<string> | null; cursor: string; previousCursor: string };

function head(db: SqliteOperations, sessionId: string) {
  const row = db.row(
    "SELECT json,content_version,origin_store_id FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    namespace,
    sessionId,
    headKey,
  );
  if (row?.content_version !== 1n || row.origin_store_id !== db.metadata().storeId) return null;
  let value: { format?: unknown; sourceCursor?: unknown };
  try {
    value = JSON.parse(String(row.json));
  } catch {
    return null;
  }
  return value?.format === 'output-delivery-index' &&
    typeof value.sourceCursor === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value.sourceCursor)
    ? { sourceCursor: value.sourceCursor }
    : null;
}

function hasOutputRecords(db: SqliteOperations, sessionId: string) {
  return !!db.row(
    `SELECT 1 FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=?
      AND ((key>='delivery/' AND key<'delivery0') OR (key>='collection/' AND key<'collection0')) LIMIT 1`,
    namespace,
    sessionId,
  );
}

/** Derived rows are private metadata. They neither publish content nor grant a read capability. */
function put(db: SqliteOperations, sessionId: string, key: string, value: Json) {
  const text = canonicalJson(value);
  db.run(
    `INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json)
     VALUES(?,'session',?,?,1,?,1,?,?)
     ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET
       revision=extension_record.revision+1,json=excluded.json,origin_store_id=excluded.origin_store_id,
       content_type=excluded.content_type,content_version=excluded.content_version
     WHERE extension_record.json<>excluded.json OR extension_record.origin_store_id<>excluded.origin_store_id
       OR extension_record.content_type<>excluded.content_type OR extension_record.content_version<>excluded.content_version`,
    namespace,
    sessionId,
    key,
    contentType,
    db.metadata().storeId,
    text,
  );
}

/** Must run inside the source writer's transaction. Original deliveries remain untouched. */
function refresh(db: SqliteOperations, sessionId: string, prefix: string) {
  const wanted = new Set<string>();
  for (const row of projectOutputDeliveries(db, sessionId, prefix)) {
    const key = `${indexPrefix}${row.key}`;
    wanted.add(key);
    put(db, sessionId, key, { deliveryKey: String(row.key) });
  }
  const indexedPrefix = `${indexPrefix}${prefix}`;
  for (const row of db.rows(
    "SELECT key FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key>=? AND key<?",
    namespace,
    sessionId,
    indexedPrefix,
    `${indexedPrefix}\uffff`,
  )) {
    if (!wanted.has(String(row.key)))
      db.run(
        "DELETE FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
        namespace,
        sessionId,
        String(row.key),
      );
  }
}

/** One writer-owned read model. The queue is transaction-local, including on rollback. */
export class OutputFileIndex {
  private readonly pending = new Map<string, Changes>();
  private readonly db: SqliteOperations;
  constructor(db: SqliteOperations) {
    this.db = db;
  }

  note(sessionId: string | null, object: string, type: string) {
    if (!sessionId) return;
    let prefix: string | null;
    const record = /^builtin\.files\/(?:delivery|collection)\/([0-9]{20})\//.exec(object);
    if (type === 'extension.record_updated' && record) prefix = `delivery/${record[1]}/`;
    else if (type === 'run.finished' || type === 'run.started' || type === 'run.interrupted') {
      const run = this.db.row(
        'SELECT c.seq FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.id=? AND r.session_id=?',
        object,
        sessionId,
      );
      if (!run) return;
      prefix = `delivery/${String(run.seq).padStart(20, '0')}/`;
    } else if (type === 'session.forked') prefix = null;
    else return;
    const cursor = this.db.metadata().lastChangeCursor;
    const prior = this.pending.get(sessionId);
    if (prior) {
      prior.cursor = cursor;
      if (prefix === null) prior.prefixes = null;
      else prior.prefixes?.add(prefix);
    } else {
      const previousCursor = String(
        this.db.row(
          `SELECT COALESCE(MAX(cursor),0) AS cursor FROM change_event WHERE scope_session_id=? AND cursor<? AND (${sourceEvents})`,
          sessionId,
          BigInt(cursor),
        )!.cursor,
      );
      this.pending.set(sessionId, {
        prefixes: prefix === null ? null : new Set([prefix]),
        cursor,
        previousCursor,
      });
    }
  }

  discard() {
    this.pending.clear();
  }

  flush() {
    for (const [sessionId, change] of this.pending) {
      const session = this.db.row('SELECT delete_requested FROM session WHERE id=?', sessionId);
      if (!session || session.delete_requested) continue;
      // Do not manufacture a Files namespace in sessions that never produced outputs.
      if (!hasOutputRecords(this.db, sessionId)) continue;
      // A missing head means legacy data, not an empty prior result.
      const saved = head(this.db, sessionId);
      // A previous binary may have changed a different Run before this transaction.
      // Never certify its stale rows by advancing the head for only our current prefix.
      const prefixes = saved?.sourceCursor === change.previousCursor ? change.prefixes : null;
      if (prefixes === null) refresh(this.db, sessionId, 'delivery/');
      else for (const prefix of prefixes) refresh(this.db, sessionId, prefix);
      put(this.db, sessionId, headKey, {
        format: 'output-delivery-index',
        sourceCursor: change.cursor,
      });
    }
    this.discard();
  }

  /** Read/write Store startup only: metadata backfill, never execution-owner acquisition.
   * Source event watermarks also catch writes made by an older producer since the last open.
   * Scan the event frontier once, not once per historical Session or output page. */
  initialize() {
    if (this.db.readonly) return;
    if (
      !this.db.row(
        `SELECT 1 FROM extension_record WHERE extension_id='builtin.files'
        AND content_type IN ('builtin.files.delivery','builtin.files.collection') LIMIT 1`,
      )
    )
      return;
    const frontiers = new Map(
      this.db
        .rows(
          `SELECT scope_session_id,MAX(cursor) AS cursor FROM change_event WHERE ${sourceEvents} GROUP BY scope_session_id`,
        )
        .map((row) => [String(row.scope_session_id), String(row.cursor)]),
    );
    let after = '';
    for (;;) {
      const sessions = this.db.rows(
        `SELECT id FROM session s WHERE id>? AND delete_requested=0 AND EXISTS (
          SELECT 1 FROM extension_record r WHERE r.extension_id='builtin.files' AND r.scope_kind='session' AND r.scope_id=s.id
          AND ((r.key>='delivery/' AND r.key<'delivery0') OR (r.key>='collection/' AND r.key<'collection0')))
          ORDER BY id LIMIT 50`,
        after,
      );
      for (const session of sessions) {
        const sessionId = String(session.id);
        const observed = frontiers.get(sessionId) ?? '0';
        const saved = head(this.db, sessionId);
        if (saved && BigInt(saved.sourceCursor) >= BigInt(observed)) continue;
        // Recheck both sides under the writer lock, including a peer's newer source fact.
        this.db.tx(() => {
          const prior = head(this.db, sessionId);
          const sourceCursor = String(
            this.db.row(
              `SELECT COALESCE(MAX(cursor),0) AS cursor FROM change_event WHERE scope_session_id=? AND (${sourceEvents})`,
              sessionId,
            )!.cursor,
          );
          if (prior && prior.sourceCursor === sourceCursor) return;
          refresh(this.db, sessionId, 'delivery/');
          put(this.db, sessionId, headKey, { format: 'output-delivery-index', sourceCursor });
        });
      }
      if (sessions.length < 50) return;
      after = String(sessions.at(-1)!.id);
    }
  }
}

/** Normal reads are key-range reads of the saved projection. Readonly legacy inspection
 * remains possible without granting a GET permission to migrate or recover work. */
export function readOutputFileIndex(
  db: SqliteOperations,
  sessionId: string,
  prefix: string,
  beforeKey: string | undefined,
  limit: number,
) {
  if (!hasOutputRecords(db, sessionId)) return [];
  const saved = head(db, sessionId);
  const sourceCursor = String(
    db.row(
      `SELECT COALESCE(MAX(cursor),0) AS cursor FROM change_event WHERE scope_session_id=? AND (${sourceEvents})`,
      sessionId,
    )!.cursor,
  );
  // A previous binary can still write this Store schema. Its original events
  // invalidate the saved projection instead of allowing stale indexed reads.
  if (!saved || saved.sourceCursor !== sourceCursor)
    return projectOutputDeliveries(db, sessionId, prefix, beforeKey, limit);
  const indexedPrefix = `${indexPrefix}${prefix}`;
  return db.rows(
    `SELECT d.key,d.json FROM extension_record i
     JOIN extension_record d ON d.extension_id=i.extension_id AND d.scope_kind=i.scope_kind
       AND d.scope_id=i.scope_id AND d.key=json_extract(i.json,'$.deliveryKey')
     WHERE i.extension_id=? AND i.scope_kind='session' AND i.scope_id=?
       AND i.key>=? AND i.key<? AND i.key<? ORDER BY i.key DESC LIMIT ?`,
    namespace,
    sessionId,
    indexedPrefix,
    `${indexedPrefix}\uffff`,
    beforeKey ? `${indexPrefix}${beforeKey}` : `${indexedPrefix}\uffff`,
    limit,
  );
}
