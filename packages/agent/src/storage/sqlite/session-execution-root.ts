import { canonicalJson } from '../../json';
import type { FinishExecutionInput, Store } from '../port';
import {
  AgentError,
  type Json,
  type SessionExecutionRoot,
  type SessionExecutionRootPreparation,
} from '../types';
import { verifyHostControlReads } from './host-control-dispatch';
import { modelOutputOf, verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
type Prepare = Parameters<Store['prepareSessionExecutionRoot']>[0];
type Identity = NonNullable<SessionExecutionRoot['identity']>;
interface Candidate {
  action: 'use' | 'exit';
  expectedEpoch: string;
  source: Prepare['source'];
  target: Prepare['target'];
  binding: SessionExecutionRoot;
}
const namespace = 'host.session-execution-root';
const contentType = 'application/vnd.kite.session-execution-root+json';
const json = (value: unknown) => value as Json;
const equal = (a: unknown, b: unknown) => canonicalJson(json(a)) === canonicalJson(json(b));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
function identity(value: unknown): value is Identity {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'dev,ino' &&
    ['dev', 'ino'].every(
      (key) => typeof value[key] === 'string' && /^[0-9]{1,40}$/.test(value[key] as string),
    )
  );
}
function uri(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0'))
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'file:' && !url.hostname && !url.search && !url.hash && url.href === value
    );
  } catch {
    return false;
  }
}
function fail(code = 'execution_root_unverifiable'): never {
  throw new AgentError(code);
}
function session(db: SqliteOperations, sessionId: string) {
  const row = db.row(
    'SELECT s.*,w.root_uri FROM session s JOIN workspace w ON w.id=s.workspace_id WHERE s.id=?',
    sessionId,
  );
  if (!row) fail('session_not_found');
  return row;
}
function read(db: SqliteOperations, sessionId: string, key: string): unknown {
  const row = db.row(
    `SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='host' AND scope_id=? AND key=?`,
    namespace,
    sessionId,
    key,
  );
  if (!row) return undefined;
  if (
    row.content_type !== contentType ||
    Number(row.content_version) !== 1 ||
    !row.origin_store_id ||
    row.fork_provenance_json !== null
  )
    fail();
  try {
    return JSON.parse(String(row.json));
  } catch {
    return fail();
  }
}
function write(
  db: SqliteOperations,
  sessionId: string,
  key: string,
  value: unknown,
  replace = false,
) {
  db.run(
    `INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json)
     VALUES(?,'host',?,?,1,?,1,?,?)${replace ? ' ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET revision=revision+1,origin_store_id=excluded.origin_store_id,json=excluded.json' : ''}`,
    namespace,
    sessionId,
    key,
    contentType,
    db.metadata().storeId,
    canonicalJson(json(value)),
  );
}
function binding(value: unknown, row: Row, epoch?: string): SessionExecutionRoot {
  if (
    !object(value) ||
    !exact(value, [
      'sessionId',
      'workspaceId',
      'effectiveRootUri',
      'epoch',
      'identity',
      'activationExecutionId',
    ]) ||
    value.sessionId !== row.id ||
    value.workspaceId !== row.workspace_id ||
    !uri(value.effectiveRootUri) ||
    !decimal(value.epoch) ||
    (epoch !== undefined && value.epoch !== epoch) ||
    (value.identity !== null && !identity(value.identity)) ||
    (value.epoch !== '0' && !identity(value.identity)) ||
    (value.activationExecutionId !== undefined &&
      (typeof value.activationExecutionId !== 'string' || !value.activationExecutionId))
  )
    fail();
  return value as unknown as SessionExecutionRoot;
}
/** Pure metadata read. Epoch zero is the old fixed Workspace until a real binding is published. */
export function getSessionExecutionRoot(
  db: SqliteOperations,
  input: Parameters<Store['getSessionExecutionRoot']>[0],
): SessionExecutionRoot {
  if (!exact(input, ['sessionId', 'epoch']) || (input.epoch !== undefined && !decimal(input.epoch)))
    fail();
  const row = session(db, input.sessionId);
  const saved = read(
    db,
    input.sessionId,
    input.epoch === undefined ? 'current' : `epoch:${input.epoch}`,
  );
  if (saved !== undefined) return binding(saved, row, input.epoch);
  if (input.epoch !== undefined && input.epoch !== '0') fail('execution_root_epoch_unavailable');
  return {
    sessionId: String(row.id),
    workspaceId: String(row.workspace_id),
    effectiveRootUri: String(row.root_uri),
    epoch: '0',
    identity: null,
  };
}
/** Called in one read transaction. Never return a partial occupancy list. */
export function listSessionExecutionRoots(
  db: SqliteOperations,
  input: Parameters<Store['listSessionExecutionRoots']>[0],
) {
  if (!exact(input, ['expectedStoreId'])) fail();
  db.identity(input.expectedStoreId);
  const sessions = db.rows('SELECT id FROM session ORDER BY id LIMIT 10001');
  if (sessions.length > 10000) fail('execution_root_inventory_limit');
  const roots: SessionExecutionRoot[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const include = (root: SessionExecutionRoot) => {
    const key = JSON.stringify([root.sessionId, root.epoch]);
    if (seen.has(key)) return;
    bytes += Buffer.byteLength(canonicalJson(json(root)));
    if (bytes > 1024 * 1024) fail('execution_root_inventory_limit');
    seen.add(key);
    roots.push(root);
  };
  for (const row of sessions) include(getSessionExecutionRoot(db, { sessionId: String(row.id) }));
  const executions = db.rows(
    `SELECT id,session_id,json_type(decision_source_json,'$.executionRoot') AS root_type,
      substr(json_extract(decision_source_json,'$.executionRoot'),1,32769) AS root_json
      FROM execution WHERE state IN ('planned','dispatching','running','outcome_unknown') ORDER BY id LIMIT 10001`,
  );
  if (executions.length > 10000) fail('execution_root_inventory_limit');
  for (const execution of executions) {
    const sessionId = String(execution.session_id);
    if (
      execution.root_type !== null &&
      (execution.root_type !== 'object' || String(execution.root_json).length > 32768)
    )
      fail();
    const sealed =
      execution.root_type === null ? undefined : JSON.parse(String(execution.root_json));
    const original =
      sealed === undefined
        ? getSessionExecutionRoot(db, { sessionId, epoch: '0' })
        : binding(sealed, session(db, sessionId));
    const saved = getSessionExecutionRoot(db, { sessionId, epoch: original.epoch });
    if (
      saved.effectiveRootUri !== original.effectiveRootUri ||
      (saved.identity !== null && !equal(saved.identity, original.identity))
    )
      fail();
    include(original);
    const reservation = candidate(db, sessionId, String(execution.id));
    if (reservation) include(reservation.binding);
  }
  return {
    roots,
    snapshotCursor: db.metadata().lastChangeCursor,
  };
}
function candidate(
  db: SqliteOperations,
  sessionId: string,
  executionId: string,
): Candidate | undefined {
  const value = read(db, sessionId, `prepare:${executionId}`);
  if (value === undefined) return;
  if (
    !object(value) ||
    !exact(value, ['action', 'expectedEpoch', 'source', 'target', 'binding']) ||
    !['use', 'exit'].includes(String(value.action)) ||
    !decimal(value.expectedEpoch) ||
    !object(value.source) ||
    !exact(value.source, ['rootUri', 'identity']) ||
    !uri(value.source.rootUri) ||
    !identity(value.source.identity) ||
    !object(value.target) ||
    !exact(value.target, ['rootUri', 'identity', 'requestedPath']) ||
    !uri(value.target.rootUri) ||
    !identity(value.target.identity)
  )
    fail();
  const next = binding(
    value.binding,
    session(db, sessionId),
    String(BigInt(value.expectedEpoch) + 1n),
  );
  if (
    next.activationExecutionId !== executionId ||
    next.effectiveRootUri !== value.target.rootUri ||
    !equal(next.identity, value.target.identity)
  )
    fail();
  return value as unknown as Candidate;
}
export function getSessionExecutionRootPreparation(
  db: SqliteOperations,
  input: Parameters<Store['getSessionExecutionRootPreparation']>[0],
): SessionExecutionRootPreparation | null {
  if (!exact(input, ['sessionId', 'executionId'])) fail();
  session(db, input.sessionId);
  const prepared = candidate(db, input.sessionId, input.executionId);
  if (!prepared) return null;
  const committed = read(db, input.sessionId, `activation:${input.executionId}`);
  if (committed !== undefined && !equal(committed, prepared.binding)) fail();
  return { state: committed === undefined ? 'prepared' : 'committed', binding: prepared.binding };
}
/** Verify the genuine single-call Model batch, not a marker from Tool input. */
function sourceTool(db: SqliteOperations, execution: Row): 'use' | 'exit' {
  const input = JSON.parse(String(execution.intent_json));
  const source = JSON.parse(String(execution.decision_source_json));
  const model =
    source && typeof source.modelExecutionId === 'string'
      ? db.row('SELECT * FROM execution WHERE id=?', source.modelExecutionId)
      : null;
  const run = execution.run_id && db.row('SELECT * FROM run WHERE id=?', execution.run_id);
  const config = run && JSON.parse(String(run.config_json));
  if (
    execution.kind !== 'tool' ||
    execution.adapter_id !== 'git.worktree' ||
    execution.definition_version !== '1' ||
    (execution.dispatched !== 1n && execution.dispatched !== 1) ||
    !object(input) ||
    !['use', 'exit'].includes(String(input.action)) ||
    !exact(input, input.action === 'use' ? ['action', 'path'] : ['action']) ||
    (input.action === 'use' && (typeof input.path !== 'string' || !input.path)) ||
    !object(source) ||
    source.kind !== 'model_decision' ||
    source.toolBatchSize !== 1 ||
    !model ||
    model.kind !== 'model' ||
    model.state !== 'succeeded' ||
    [
      'session_id',
      'run_id',
      'origin_store_id',
      'origin_command_id',
      'root_work_command_id',
      'root_work_seq',
    ].some((key) => model[key] !== execution[key]) ||
    !config ||
    !Array.isArray(config.tools) ||
    !config.tools.some(
      (tool: Record<string, unknown>) =>
        tool.id === 'git.worktree' && tool.version === '1' && tool.extensionId === 'builtin.shell',
    ) ||
    !Array.isArray(config.extensions) ||
    !config.extensions.some(
      (extension: Record<string, unknown>) =>
        extension.id === 'builtin.shell' && extension.version === '1',
    )
  )
    fail('execution_root_source_invalid');
  const output = JSON.parse(String(model.result_json));
  const descriptor = modelOutputOf(output);
  if (descriptor !== undefined) {
    const verified = verifyModelOutput(db, descriptor, model);
    if (!verified.complete || verified.toolCallCount !== 1) fail('execution_root_batch_invalid');
  } else {
    const calls = output?.toolCalls;
    const call = Array.isArray(calls) && calls.length === 1 ? calls[0] : null;
    if (!call || call.id !== execution.call_id || call.name !== execution.adapter_id)
      fail('execution_root_batch_invalid');
    try {
      if (!equal(JSON.parse(call.arguments), input)) fail('execution_root_batch_invalid');
    } catch {
      fail('execution_root_batch_invalid');
    }
  }
  return input.action as 'use' | 'exit';
}
function frontier(db: SqliteOperations, execution: Row) {
  if (
    db.row(
      `SELECT id FROM execution WHERE session_id=? AND id<>? AND kind IN ('tool','model')
     AND state IN ('planned','dispatching','running','outcome_unknown') LIMIT 1`,
      execution.session_id!,
      execution.id!,
    )
  )
    fail('execution_root_busy');
}
function fresh(db: SqliteOperations, execution: Row, prepared: Candidate) {
  const current = getSessionExecutionRoot(db, { sessionId: String(execution.session_id) });
  if (
    current.epoch !== prepared.expectedEpoch ||
    current.effectiveRootUri !== prepared.source.rootUri ||
    (current.identity !== null && !equal(current.identity, prepared.source.identity))
  )
    fail('execution_root_conflict');
  const input = JSON.parse(String(execution.intent_json));
  if (
    input.action !== prepared.action ||
    (prepared.action === 'use'
      ? input.path !== prepared.target.requestedPath
      : prepared.target.requestedPath !== undefined ||
        prepared.target.rootUri !== session(db, String(execution.session_id)).root_uri)
  )
    fail('execution_root_target_invalid');
  frontier(db, execution);
  const accepted = JSON.parse(String(execution.dispatch_authorization_json));
  if (accepted?.allowed !== true) fail('execution_root_source_invalid');
  verifyHostControlReads(db, execution, db.metadata().storeId, accepted.controlReads);
  return current;
}
export function prepareSessionExecutionRoot(
  db: SqliteOperations,
  input: Prepare,
): SessionExecutionRoot {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    db.owner(input.owner, input.sessionId);
    if (
      !exact(input, [
        'expectedStoreId',
        'owner',
        'sessionId',
        'executionId',
        'expectedEpoch',
        'action',
        'source',
        'target',
      ]) ||
      !decimal(input.expectedEpoch) ||
      BigInt(input.expectedEpoch) === 9223372036854775807n ||
      !object(input.source) ||
      !uri(input.source.rootUri) ||
      !identity(input.source.identity) ||
      !exact(input.source, ['rootUri', 'identity']) ||
      !object(input.target) ||
      !uri(input.target.rootUri) ||
      !identity(input.target.identity) ||
      !exact(input.target, ['rootUri', 'identity', 'requestedPath'])
    )
      fail('execution_root_target_invalid');
    const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
    if (
      !execution ||
      execution.session_id !== input.sessionId ||
      execution.origin_store_id !== input.expectedStoreId ||
      String(execution.owner_generation) !== input.owner.generation ||
      !['dispatching', 'running'].includes(String(execution.state))
    )
      fail('execution_root_source_invalid');
    const action = sourceTool(db, execution);
    if (action !== input.action) fail('execution_root_source_invalid');
    db.active(input.owner, String(execution.origin_command_id), String(execution.run_id));
    db.ancestors(input.owner, input.executionId);
    const row = session(db, input.sessionId);
    const next: SessionExecutionRoot = {
      sessionId: input.sessionId,
      workspaceId: String(row.workspace_id),
      effectiveRootUri: input.target.rootUri,
      epoch: String(BigInt(input.expectedEpoch) + 1n),
      identity: input.target.identity,
      activationExecutionId: input.executionId,
    };
    const value: Candidate = {
      action,
      expectedEpoch: input.expectedEpoch,
      source: input.source,
      target: input.target,
      binding: next,
    };
    fresh(db, execution, value);
    const prior = candidate(db, input.sessionId, input.executionId);
    if (prior) {
      if (!equal(prior, value)) fail('execution_root_conflict');
      return prior.binding;
    }
    // Serialize the admission of root reservations against already planned destructive Tools.
    // The opposite order is guarded by occupancy including this private reservation.
    if (
      db.row(`SELECT id FROM execution WHERE kind='tool' AND adapter_id='git.worktree'
      AND definition_version='1' AND state IN ('planned','dispatching','running','outcome_unknown')
      AND json_extract(intent_json,'$.action')='remove' LIMIT 1`)
    )
      fail('execution_root_remove_pending');
    write(db, input.sessionId, `prepare:${input.executionId}`, value);
    db.event(input.sessionId, input.executionId, 'session.execution_root.prepared');
    return next;
  });
}
/** Runs inside finishExecution, before Tool result/message publication; rollback covers every fact. */
export function finalizeSessionExecutionRoot(
  db: SqliteOperations,
  execution: Row,
  input: Pick<FinishExecutionInput, 'owner' | 'result'> & { status: string },
): void {
  if (
    execution.kind !== 'tool' ||
    execution.adapter_id !== 'git.worktree' ||
    input.status !== 'succeeded'
  )
    return;
  const intent = JSON.parse(String(execution.intent_json));
  if (!['use', 'exit'].includes(intent?.action)) return;
  sourceTool(db, execution);
  const prepared = candidate(db, String(execution.session_id), String(execution.id));
  if (!prepared) fail('execution_root_preparation_missing');
  const result = input.result;
  if (
    !object(result) ||
    result.outcome !== 'succeeded' ||
    !object(result.details) ||
    result.details.action !== prepared.action ||
    result.details.cwdChanged !== true ||
    !equal(result.details.executionRoot, prepared.binding)
  )
    fail('execution_root_result_invalid');
  db.active(input.owner, String(execution.origin_command_id), String(execution.run_id));
  db.ancestors(input.owner, String(execution.id));
  const previous = fresh(db, execution, prepared);
  const sessionId = String(execution.session_id);
  if (read(db, sessionId, `epoch:${previous.epoch}`) === undefined)
    write(db, sessionId, `epoch:${previous.epoch}`, {
      ...previous,
      identity: prepared.source.identity,
    });
  write(db, sessionId, `epoch:${prepared.binding.epoch}`, prepared.binding);
  write(db, sessionId, `activation:${execution.id}`, prepared.binding);
  write(db, sessionId, 'current', prepared.binding, true);
  db.event(sessionId, String(execution.id), 'session.execution_root.changed');
}

/** A new child inherits the exact parent dispatch epoch, never the parent's later current root. */
export function inheritSessionExecutionRoot(
  db: SqliteOperations,
  parent: Row,
  childSessionId: string,
) {
  const accepted = JSON.parse(String(parent.dispatch_authorization_json));
  const reads = accepted?.controlReads;
  const selected = Array.isArray(reads)
    ? reads.filter(
        (read) =>
          read.kind === 'session.execution_root' && read.scope === `session:${parent.session_id}`,
      )
    : [];
  if (selected.length > 1) fail();
  const source = getSessionExecutionRoot(db, {
    sessionId: String(parent.session_id),
    epoch: selected[0]?.revision ?? '0',
  });
  const child = session(db, childSessionId);
  if (child.workspace_id !== source.workspaceId || child.parent_id !== parent.session_id) fail();
  const value: SessionExecutionRoot = {
    sessionId: childSessionId,
    workspaceId: source.workspaceId,
    effectiveRootUri: source.effectiveRootUri,
    epoch: '0',
    identity: source.identity,
  };
  // Keep the untouched default implicit, so its first validated host source can pin epoch zero.
  if (source.identity === null && source.effectiveRootUri === child.root_uri) return;
  write(db, childSessionId, 'epoch:0', value);
  write(db, childSessionId, 'current', value);
}

/** Fork gets a new epoch-zero binding, not authority from source candidates or receipts. */
export function forkSessionExecutionRoot(
  db: SqliteOperations,
  sourceSessionId: string,
  targetSessionId: string,
) {
  const source = getSessionExecutionRoot(db, { sessionId: sourceSessionId });
  const target = session(db, targetSessionId);
  if (target.workspace_id !== source.workspaceId || target.parent_id !== null) fail();
  if (source.identity === null && source.effectiveRootUri === target.root_uri) return;
  const value: SessionExecutionRoot = {
    sessionId: targetSessionId,
    workspaceId: source.workspaceId,
    effectiveRootUri: source.effectiveRootUri,
    epoch: '0',
    identity: source.identity,
  };
  write(db, targetSessionId, 'epoch:0', value);
  write(db, targetSessionId, 'current', value);
}
