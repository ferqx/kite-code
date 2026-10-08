import { createHash } from 'node:crypto';
import type { ForkReadSourceDeclaration } from '../../extensions/fork';
import { canonicalJson } from '../../json';
import { bodyReference } from '../../model-body';
import type { Store } from '../port';
import {
  AgentError,
  type ArtifactReference,
  type ForkReadonlyProof,
  type ForkReadonlySource,
  type ForkSourceObservation,
  type Json,
} from '../types';
import { historyOnlyCompression } from './compression-operations';
import { filter, selected } from './context-selection-operations';
import { readExecutionGroupSafety } from './execution-group-safety';
import { messageOriginRow } from './fork-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
type Scope = { expectedStoreId: string; sessionId: string; subjectId: string; extensionId: string };
const fail = (): never => {
  throw new AgentError('fork_source_unverifiable');
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(
      canonicalJson(
        JSON.parse(
          JSON.stringify(value, (_key, cell) => (typeof cell === 'bigint' ? String(cell) : cell)),
        ) as Json,
      ),
    )
    .digest('hex');
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
const parse = (value: unknown) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return fail();
  }
};
const keys = (value: unknown, allowed: string[]) => {
  const o = obj(value);
  if (Object.keys(o).some((k) => !allowed.includes(k))) return fail();
  return o;
};
const finite = (value: unknown) => {
  if (
    Buffer.byteLength(
      canonicalJson(
        JSON.parse(
          JSON.stringify(value, (_key, cell) => (typeof cell === 'bigint' ? String(cell) : cell)),
        ) as Json,
      ),
    ) >
    1024 * 1024
  )
    throw new AgentError('fork_source_budget_exceeded');
};
function session(db: SqliteOperations, id: string, subject: string, historical = false) {
  const s = db.row('SELECT * FROM session WHERE id=?', id);
  const c = db.row("SELECT * FROM command WHERE session_id=? AND kind='session.create'", id);
  if (
    !s ||
    s.parent_id !== null ||
    (s.delete_requested && (!historical || db.session(s).historyPurgedAt !== undefined)) ||
    c?.subject_id !== subject ||
    c.status !== 'applied'
  )
    return fail();
  return s;
}
function executionProjection(row: Row) {
  const fields = [
    'id',
    'session_id',
    'run_id',
    'kind',
    'origin_command_id',
    'origin_store_id',
    'root_work_command_id',
    'root_work_seq',
    'root_session_id',
    'step_id',
    'call_id',
    'attempt',
    'adapter_id',
    'definition_version',
    'state',
    'intent_json',
    'decision_source_json',
    'result_json',
    'result_revision',
    'reference_json',
    'model_snapshot_json',
    'dispatch_authorization_json',
  ];
  return fields.map((k) => [k, row[k] ?? null]);
}
function stamp(
  db: SqliteOperations,
  kind: ForkReadonlyProof['stamps'][number]['kind'],
  id: string,
): string {
  if (kind === 'execution') {
    const row = db.row('SELECT * FROM execution WHERE id=?', id);
    if (!row) return fail();
    return hash(executionProjection(row));
  }
  if (kind === 'run') {
    const row = db.row('SELECT * FROM run WHERE id=?', id);
    if (!row) return fail();
    return hash(
      [
        'id',
        'session_id',
        'origin_command_id',
        'origin_store_id',
        'context_selection_id',
        'config_json',
        'state',
        'is_active',
      ].map((k) => [k, row[k] ?? null]),
    );
  }
  if (kind === 'command') {
    const row = db.row('SELECT * FROM command WHERE id=?', id);
    if (!row) return fail();
    return hash(
      [
        'id',
        'session_id',
        'origin_store_id',
        'subject_id',
        'kind',
        'status',
        'request_json',
        'receipt_json',
        'request_digest',
      ].map((k) => [k, row[k] ?? null]),
    );
  }
  if (kind === 'message') {
    const row = db.row(
      'SELECT id,session_id,run_id,seq,role,status,source_json,fork_source_message_id FROM message WHERE id=?',
      id,
    );
    if (!row) return fail();
    const parts = db.rows(
      'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal LIMIT 8193',
      id,
    );
    if (parts.length > 8192) return fail();
    return hash([row, parts]);
  }
  const row = db.row(
    'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=?',
    id,
  );
  if (!row) return fail();
  return hash(row);
}
function artifact(
  db: SqliteOperations,
  id: string,
  scope: { sessionId: string; subjectId: string; executionId: string; originStoreId: string },
): ArtifactReference {
  const r = db.row(
    'SELECT r.*,CAST(b.size AS TEXT) AS size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=?',
    id,
  );
  if (
    !r ||
    r.session_id !== scope.sessionId ||
    r.subject_id !== scope.subjectId ||
    r.origin_store_id !== scope.originStoreId ||
    r.owner_kind !== 'execution' ||
    r.owner_id !== scope.executionId
  )
    return fail();
  return {
    id: String(r.id),
    storeId: String(r.origin_store_id),
    sessionId: String(r.session_id),
    subjectId: String(r.subject_id),
    scope: { kind: 'execution', id: String(r.owner_id) },
    hash: String(r.blob_hash),
    size: String(r.size),
    mediaType: String(r.media_type),
  };
}
export function assertReadonlyProof(
  db: SqliteOperations,
  scope: Scope,
  proof: ForkReadonlyProof,
  requireBodies = true,
) {
  keys(proof, ['version', 'sources', 'stamps', 'models']);
  if (
    proof.version !== 1 ||
    !Array.isArray(proof.sources) ||
    proof.sources.length > 64 ||
    !Array.isArray(proof.stamps) ||
    proof.stamps.length > 8192 ||
    !Array.isArray(proof.models) ||
    proof.models.length > 64
  )
    return fail();
  finite(proof);
  const ids = new Set<string>();
  for (const s of proof.sources) {
    keys(s, [
      'executionId',
      'sessionId',
      'originStoreId',
      'kind',
      'runId',
      'modelExecutionId',
      'artifactRefs',
    ]);
    if (ids.has(s.executionId) || !Array.isArray(s.artifactRefs) || s.artifactRefs.length > 64)
      return fail();
    ids.add(s.executionId);
    const ss = session(db, s.sessionId, scope.subjectId, true),
      current = session(db, scope.sessionId, scope.subjectId);
    if (ss.workspace_id !== current.workspace_id) return fail();
    const e = db.row(
      'SELECT * FROM execution WHERE id=? AND session_id=?',
      s.executionId,
      s.sessionId,
    );
    const c = e && db.row('SELECT * FROM command WHERE id=?', e.origin_command_id!);
    if (
      !e ||
      !c ||
      c.subject_id !== scope.subjectId ||
      c.session_id !== e.session_id ||
      e.root_session_id !== s.sessionId ||
      c.origin_store_id !== e.origin_store_id ||
      e.origin_store_id !== s.originStoreId ||
      e.kind !== s.kind ||
      !['succeeded', 'failed', 'cancelled'].includes(String(e.state)) ||
      (e.run_id === null ? null : String(e.run_id)) !== s.runId
    )
      return fail();
    if (s.runId) {
      const run = db.row('SELECT * FROM run WHERE id=?', s.runId);
      if (
        !run ||
        run.session_id !== s.sessionId ||
        run.origin_store_id !== s.originStoreId ||
        run.origin_command_id !== e.root_work_command_id
      )
        return fail();
    }
    const d = obj(parse(e.decision_source_json));
    const modelId = s.kind === 'tool' && d.kind === 'model_decision' ? d.modelExecutionId : null;
    if ((modelId ?? null) !== s.modelExecutionId) return fail();
    if (modelId) {
      if (!proof.sources.some((x) => x.executionId === modelId && x.kind === 'model'))
        return fail();
      const m = db.row(
        "SELECT * FROM execution WHERE id=? AND kind='model' AND state='succeeded'",
        String(modelId),
      );
      if (
        !m ||
        m.session_id !== e.session_id ||
        m.run_id !== e.run_id ||
        m.origin_store_id !== e.origin_store_id ||
        m.root_work_command_id !== e.root_work_command_id
      )
        return fail();
    }
    if (s.kind === 'model') {
      const assistant = db.rows(
        "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='assistant' AND status='complete' AND json_array_length(json_extract(source_json,'$.sourceIds'))=1 AND json_extract(source_json,'$.sourceIds[0]')=?",
        s.sessionId,
        s.runId!,
        s.executionId,
      );
      if (
        assistant.length !== 1 ||
        !proof.stamps.some((p) => p.kind === 'message' && p.id === assistant[0]!.id)
      )
        return fail();
      const input = obj(parse(e.intent_json)),
        meta = e.model_snapshot_json === null ? null : obj(parse(e.model_snapshot_json));
      for (const value of [input.body, meta?.body]) {
        const b = bodyReference(value);
        if (b && !proof.stamps.some((p) => p.kind === 'artifact' && p.id === b.reference.id))
          return fail();
      }
    }
    for (const r of s.artifactRefs) {
      if (!proof.stamps.some((x) => x.kind === 'artifact' && x.id === r.id)) return fail();
      const actual = artifact(db, r.id, {
        sessionId: s.sessionId,
        subjectId: scope.subjectId,
        executionId: s.executionId,
        originStoreId: s.originStoreId,
      });
      if (canonicalJson(actual as unknown as Json) !== canonicalJson(r as unknown as Json))
        return fail();
    }
    if (
      !proof.stamps.some((x) => x.kind === 'execution' && x.id === s.executionId) ||
      !proof.stamps.some((x) => x.kind === 'command' && x.id === c.id) ||
      (s.runId && !proof.stamps.some((x) => x.kind === 'run' && x.id === s.runId))
    )
      return fail();
  }
  const seen = new Set<string>();
  for (const p of proof.stamps) {
    keys(p, ['kind', 'id', 'digest']);
    if (
      !['execution', 'run', 'command', 'message', 'artifact'].includes(p.kind) ||
      typeof p.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.digest) ||
      seen.has(`${p.kind}/${p.id}`) ||
      stamp(db, p.kind, p.id) !== p.digest
    )
      return fail();
    seen.add(`${p.kind}/${p.id}`);
  }
  const bodyIds = new Set<string>();
  for (const m of proof.models) {
    keys(m, ['executionId', 'inputHash', 'outputHash']);
    if (bodyIds.has(m.executionId)) return fail();
    bodyIds.add(m.executionId);
  }
  const models = proof.sources.filter((s) => s.kind === 'model').map((s) => s.executionId);
  if (
    requireBodies &&
    (models.length !== proof.models.length ||
      proof.models.some(
        (m) =>
          !models.includes(m.executionId) ||
          !/^[a-f0-9]{64}$/.test(m.inputHash) ||
          !/^[a-f0-9]{64}$/.test(m.outputHash),
      ))
  )
    return fail();
}
function anchor(db: SqliteOperations, scope: Scope, localKey: string) {
  const current = session(db, scope.sessionId, scope.subjectId);
  const row = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    scope.extensionId,
    scope.sessionId,
    localKey,
  );
  if (!row?.fork_provenance_json) return fail();
  const p = obj(parse(row.fork_provenance_json));
  const c = db.row(
    "SELECT * FROM command WHERE id=? AND session_id=? AND kind='session.create'",
    String(p.commandId),
    scope.sessionId,
  );
  if (
    c?.status !== 'applied' ||
    c.subject_id !== scope.subjectId ||
    c.origin_store_id !== p.storeId
  )
    return fail();
  const request = obj(parse(c.request_json)),
    fork = obj(request.fork),
    receipt = obj(parse(c.receipt_json));
  if (
    p.kind !== 'fork_record' ||
    p.mode !== 'rebuild' ||
    fork.sourceSessionId !== p.sourceSessionId ||
    fork.expectedContextSelectionId !== p.sourceSelectionId ||
    receipt.sessionId !== scope.sessionId ||
    receipt.sourceSessionId !== p.sourceSessionId ||
    receipt.sourceSelectionId !== p.sourceSelectionId ||
    receipt.sourceUpperSeq !== p.sourceUpperSeq
  )
    return fail();
  const source = session(db, String(p.sourceSessionId), scope.subjectId, true);
  if (source.workspace_id !== current.workspace_id) return fail();
  const proof = p.readonlySources as ForkReadonlyProof;
  if (!proof) return fail();
  assertReadonlyProof(db, scope, proof);
  return { row, p, proof, command: c };
}
function buildProof(
  db: SqliteOperations,
  scope: Scope,
  declarations: readonly ForkReadSourceDeclaration[],
): ForkReadonlyProof {
  if (!Array.isArray(declarations) || declarations.length > 64)
    throw new AgentError('fork_source_budget_exceeded');
  session(db, scope.sessionId, scope.subjectId);
  const proof: ForkReadonlyProof = { version: 1, sources: [], stamps: [], models: [] };
  const stamps = new Map<string, ForkReadonlyProof['stamps'][number]>();
  const add = (kind: ForkReadonlyProof['stamps'][number]['kind'], id: string) =>
    stamps.set(`${kind}/${id}`, { kind, id, digest: stamp(db, kind, id) });
  const sources = new Map<string, ForkReadonlySource>();
  function addExecution(
    id: string,
    kind: string,
    refs: readonly string[],
    allowedSession = scope.sessionId,
  ) {
    const e = db.row('SELECT * FROM execution WHERE id=? AND session_id=?', id, allowedSession);
    if (!e || e.kind !== kind || !['succeeded', 'failed', 'cancelled'].includes(String(e.state)))
      return fail();
    const c = db.row('SELECT * FROM command WHERE id=?', e.origin_command_id!);
    if (!c || c.subject_id !== scope.subjectId || c.origin_store_id !== e.origin_store_id)
      return fail();
    const d = obj(parse(e.decision_source_json)),
      modelId = kind === 'tool' && d.kind === 'model_decision' ? String(d.modelExecutionId) : null;
    const source: ForkReadonlySource = {
      executionId: id,
      sessionId: String(e.session_id),
      originStoreId: String(e.origin_store_id),
      kind: kind as ForkReadonlySource['kind'],
      runId: e.run_id === null ? null : String(e.run_id),
      modelExecutionId: modelId,
      artifactRefs: refs.map((ref) =>
        artifact(db, ref, {
          sessionId: allowedSession,
          subjectId: scope.subjectId,
          executionId: id,
          originStoreId: String(e.origin_store_id),
        }),
      ),
    };
    if (sources.has(id)) {
      const old = sources.get(id)!;
      source.artifactRefs = [
        ...new Map([...old.artifactRefs, ...source.artifactRefs].map((r) => [r.id, r])).values(),
      ];
    }
    sources.set(id, source);
    add('execution', id);
    add('command', String(c.id));
    if (e.run_id !== null) add('run', String(e.run_id));
    for (const r of source.artifactRefs) add('artifact', r.id);
    if (kind === 'model') {
      const messages = db.rows(
        "SELECT * FROM message WHERE session_id=? AND run_id=? AND role='assistant' AND status='complete' AND json_array_length(json_extract(source_json,'$.sourceIds'))=1 AND json_extract(source_json,'$.sourceIds[0]')=?",
        allowedSession,
        e.run_id!,
        id,
      );
      if (messages.length !== 1 || e.state !== 'succeeded') return fail();
      add('message', String(messages[0]!.id));
      const registrations = db.rows(
        "SELECT id FROM blob_ref WHERE session_id=? AND owner_kind='execution' AND owner_id=? ORDER BY id LIMIT 8193",
        allowedSession,
        id,
      );
      if (registrations.length > 8192) return fail();
      for (const r of registrations) add('artifact', String(r.id));
      const input = obj(parse(e.intent_json)),
        meta = e.model_snapshot_json === null ? null : obj(parse(e.model_snapshot_json));
      for (const value of [input.body, meta?.body]) {
        const b = bodyReference(value);
        if (b) add('artifact', b.reference.id);
      }
    }
    if (modelId && !sources.has(modelId)) addExecution(modelId, 'model', [], allowedSession);
  }
  for (const d of declarations) {
    if (d.kind === 'execution') {
      keys(d, ['kind', 'executionId', 'executionKind', 'artifactRefIds']);
      if (
        !['model', 'tool', 'job'].includes(d.executionKind) ||
        !Array.isArray(d.artifactRefIds) ||
        d.artifactRefIds.length > 64
      )
        return fail();
      addExecution(d.executionId, d.executionKind, d.artifactRefIds);
    } else if (d.kind === 'inherited') {
      keys(d, ['kind', 'anchorKey', 'executionId', 'artifactRefIds']);
      if (!Array.isArray(d.artifactRefIds)) return fail();
      const original = anchor(db, scope, d.anchorKey);
      const s = original.proof.sources.find((s) => s.executionId === d.executionId);
      if (!s || d.artifactRefIds.some((id: string) => !s.artifactRefs.some((r) => r.id === id)))
        return fail();
      const allowed = new Set([s.executionId, ...(s.modelExecutionId ? [s.modelExecutionId] : [])]);
      for (const x of original.proof.sources.filter((x) => allowed.has(x.executionId))) {
        const refs =
          x.executionId === s.executionId
            ? x.artifactRefs.filter((r) => d.artifactRefIds.includes(r.id))
            : [];
        const prior = sources.get(x.executionId);
        sources.set(x.executionId, {
          ...x,
          artifactRefs: [
            ...new Map([...(prior?.artifactRefs ?? []), ...refs].map((r) => [r.id, r])).values(),
          ],
        });
      }
      // Carry exact original proof metadata, never query new refs or later effects.
      for (const p of original.proof.stamps) stamps.set(`${p.kind}/${p.id}`, p);
      for (const m of original.proof.models)
        if (
          allowed.has(m.executionId) &&
          !proof.models.some((x) => x.executionId === m.executionId)
        )
          proof.models.push(m);
    } else return fail();
  }
  proof.sources = [...sources.values()];
  proof.stamps = [...stamps.values()];
  if (proof.sources.length > 64 || proof.stamps.length > 8192) return fail();
  finite(proof);
  assertReadonlyProof(db, scope, proof, false);
  return proof;
}
export function prepareForkReadonlySources(
  db: SqliteOperations,
  input: Parameters<Store['prepareForkReadonlySources']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const fact = readExecutionGroupSafety(db, input);
    if (!fact.quiescent) throw new AgentError('execution_group_not_quiescent');
    const p = buildProof(db, input, input.declarations);
    db.db.run('COMMIT');
    return p;
  } catch (e) {
    db.db.run('ROLLBACK');
    throw e;
  }
}
export function forkSourceProjection(
  db: SqliteOperations,
  input: Parameters<Store['readForkSourceProjection']>[0],
): ForkSourceObservation {
  db.identity(input.expectedStoreId);
  const a = anchor(db, input, input.localKey);
  const current = session(db, input.sessionId, input.subjectId);
  const chain: { session: Row; upper: bigint; selection: ReturnType<typeof selected> }[] = [];
  let node = current;
  const seen = new Set<string>([input.sessionId]);
  const links: unknown[] = [];
  for (;;) {
    const c = db.row(
      "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
      node.id!,
    );
    if (!c) return fail();
    const req = obj(parse(c.request_json));
    if (!req.fork) break;
    if (chain.length >= 64) return fail();
    const f = obj(req.fork),
      r = obj(parse(c.receipt_json));
    if (
      typeof f.sourceSessionId !== 'string' ||
      r.sourceSessionId !== f.sourceSessionId ||
      r.sourceSelectionId !== f.expectedContextSelectionId ||
      r.sessionId !== node.id ||
      seen.has(f.sourceSessionId)
    )
      return fail();
    const source = session(db, f.sourceSessionId, input.subjectId, true);
    if (source.workspace_id !== current.workspace_id) return fail();
    const snap = db.row(
      "SELECT request_json FROM context_snapshot WHERE id=? AND session_id=? AND kind='selection'",
      String(f.expectedContextSelectionId),
      f.sourceSessionId,
    );
    const selection = snap
      ? parse(snap.request_json)
      : {
          id: f.expectedContextSelectionId,
          sessionId: f.sourceSessionId,
          ranges: [],
          tailFromSeq: '0',
        };
    chain.push({ session: source, upper: BigInt(String(r.sourceUpperSeq)), selection });
    links.push([c.request_json, c.receipt_json, snap?.request_json ?? null]);
    seen.add(String(source.id));
    node = source;
  }
  const selection = selected(db, current),
    q = filter(selection, 'seq');
  const messages = db.rows(
    `SELECT * FROM message WHERE session_id=? AND status='complete' AND ${q.sql} AND ${historyOnlyCompression()} ORDER BY seq LIMIT 8193`,
    input.sessionId,
    ...q.args,
  );
  if (messages.length > 8192) return fail();
  const aliases = messages.map((m) => {
    const original = messageOriginRow(db, m, input.subjectId);
    if (!seen.has(String(original.session_id))) return fail();
    const values = [{ sessionId: input.sessionId, messageId: String(m.id), seq: String(m.seq) }];
    for (const link of chain) {
      const seq = BigInt(String(m.seq));
      if (
        seq > link.upper ||
        !(
          seq > BigInt(link.selection.tailFromSeq) ||
          link.selection.ranges.some((r) => seq > BigInt(r.afterSeq) && seq <= BigInt(r.throughSeq))
        )
      )
        break;
      const rows = db.rows(
        "SELECT * FROM message WHERE session_id=? AND seq=? AND role=? AND status='complete'",
        link.session.id!,
        m.seq!,
        m.role!,
      );
      const matches = rows.filter((x) => {
        const o = messageOriginRow(db, x, input.subjectId);
        return (
          o.id === original.id &&
          o.session_id === original.session_id &&
          x.source_json === m.source_json
        );
      });
      if (matches.length !== 1) return fail();
      const x = matches[0]!;
      values.push({ sessionId: String(x.session_id), messageId: String(x.id), seq: String(x.seq) });
    }
    return { current: values[0]!, aliases: values };
  });
  const payload = [
    input.expectedStoreId,
    input.sessionId,
    input.subjectId,
    input.extensionId,
    a.row.revision,
    a.row.json,
    a.row.fork_provenance_json,
    a.command.request_json,
    a.command.receipt_json,
    selection,
    links,
    aliases,
    aliases.flatMap((x) => x.aliases.map((y) => [y.messageId, stamp(db, 'message', y.messageId)])),
    a.proof,
  ];
  finite(payload);
  return {
    binding: { version: 1, localKey: input.localKey, digest: hash(payload) },
    proof: a.proof,
    aliases,
  };
}
export function readForkSourceProjection(
  db: SqliteOperations,
  input: Parameters<Store['readForkSourceProjection']>[0],
) {
  db.db.run('BEGIN');
  try {
    const p = forkSourceProjection(db, input);
    db.db.run('COMMIT');
    return p;
  } catch (e) {
    db.db.run('ROLLBACK');
    throw e;
  }
}

export function readForkSourceMessage(
  db: SqliteOperations,
  input: Parameters<Store['readForkSourceMessage']>[0],
) {
  db.db.run('BEGIN');
  try {
    const p = forkSourceProjection(db, input);
    if (!p.aliases.some((x) => x.aliases.some((a) => a.messageId === input.messageId)))
      return fail();
    const row = db.row('SELECT * FROM message WHERE id=?', input.messageId);
    if (!row) return fail();
    const result = {
      ...db.message(row),
      parts: db
        .rows(
          'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=? ORDER BY ordinal LIMIT 8193',
          input.messageId,
        )
        .map((p) => ({
          ordinal: Number(p.ordinal),
          kind: String(p.kind),
          contentVersion: Number(p.content_version),
          revision: String(p.revision),
          value: parse(p.json) as Json,
        })),
    };
    if (result.parts.length > 8192) return fail();
    finite(result);
    db.db.run('COMMIT');
    return result;
  } catch (e) {
    db.db.run('ROLLBACK');
    throw e;
  }
}
