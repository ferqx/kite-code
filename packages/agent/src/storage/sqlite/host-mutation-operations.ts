import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type HostMutationRecord, type Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
function record(row: Row): HostMutationRecord {
  return {
    id: String(row.id),
    originStoreId: String(row.origin_store_id),
    subjectId: String(row.subject_id),
    kind: row.kind as HostMutationRecord['kind'],
    scope: String(row.scope),
    requestDigest: String(row.request_digest),
    safeRequest: JSON.parse(String(row.safe_request_json)) as Json,
    state: row.state as HostMutationRecord['state'],
    receipt: JSON.parse(String(row.receipt_json)) as Json,
  };
}
function identity(input: { commandId: string; subjectId: string }): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId) ||
    !input.subjectId ||
    input.subjectId.length > 256
  )
    throw new AgentError('invalid_host_mutation');
}
const controlKinds = new Set(['permission.mode', 'workspace.trust']);
const modes = new Set(['ask', 'accept_edits', 'auto', 'full']);
function sequence(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    value.length <= 19 &&
    BigInt(value) <= 9223372036854775807n
  );
}
function sessionScope(
  db: SqliteOperations,
  sessionId: string,
  subjectId: string,
  rootOnly: boolean,
): string {
  const session = db.row(
    'SELECT id,root_id,parent_id,delete_requested FROM session WHERE id=?',
    sessionId,
  );
  const root =
    session &&
    db.row(
      'SELECT id,delete_requested FROM session WHERE id=? AND parent_id IS NULL',
      session.root_id!,
    );
  const creator =
    root &&
    db.row("SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'", root.id!);
  if (!session || !root || !creator || creator.subject_id !== subjectId)
    throw new AgentError('host_control_scope_denied');
  if (rootOnly && session.parent_id !== null) throw new AgentError('group_root_required');
  if (rootOnly && (session.delete_requested || root.delete_requested))
    throw new AgentError('session_deleted');
  return `session:${root.id}`;
}
function controlScope(
  db: SqliteOperations,
  input: Parameters<Store['readHostControl']>[0],
): string {
  if (!input.subjectId || input.subjectId.length > 256 || !input.scope || input.scope.length > 256)
    throw new AgentError('invalid_host_control');
  if (input.kind === 'permission.mode') {
    if (input.scope === 'user') return 'user';
    if (!input.scope.startsWith('session:')) throw new AgentError('invalid_host_control');
    return sessionScope(db, input.scope.slice('session:'.length), input.subjectId, false);
  }
  if (input.kind !== 'workspace.trust' || !input.scope.startsWith('workspace:'))
    throw new AgentError('invalid_host_control');
  if (!db.row('SELECT id FROM workspace WHERE id=?', input.scope.slice('workspace:'.length)))
    throw new AgentError('workspace_missing');
  return input.scope;
}
function latestControl(
  db: SqliteOperations,
  input: Parameters<Store['readHostControl']>[0],
): Row | null {
  if (input.kind === 'permission.mode' && input.scope === 'user')
    return db.row(
      "SELECT rowid AS control_revision,* FROM host_mutation WHERE origin_store_id=? AND subject_id=? AND kind='permission.mode' AND state='applied' AND json_extract(safe_request_json,'$.makeDefault')=1 ORDER BY rowid DESC LIMIT 1",
      input.expectedStoreId,
      input.subjectId,
    );
  return db.row(
    "SELECT rowid AS control_revision,* FROM host_mutation WHERE origin_store_id=? AND subject_id=? AND kind=? AND scope=? AND state='applied' ORDER BY rowid DESC LIMIT 1",
    input.expectedStoreId,
    input.subjectId,
    input.kind,
    input.scope,
  );
}
function controlRevision(
  db: SqliteOperations,
  input: Parameters<Store['readHostControl']>[0],
): string {
  return String(latestControl(db, input)?.control_revision ?? '0');
}
function checkControlRevision(
  db: SqliteOperations,
  input: Parameters<Store['beginHostMutation']>[0],
): void {
  if (!controlKinds.has(input.kind)) return;
  const value = input.safeRequest as Record<string, Json>;
  if (
    controlRevision(db, { ...input, kind: input.kind as 'permission.mode' | 'workspace.trust' }) !==
    value.ifRevision
  )
    throw new AgentError('host_control_conflict');
  if (
    input.kind === 'permission.mode' &&
    value.makeDefault === true &&
    controlRevision(db, { ...input, kind: 'permission.mode', scope: 'user' }) !==
      value.ifDefaultRevision
  )
    throw new AgentError('host_control_conflict');
}
function safe(db: SqliteOperations, input: Parameters<Store['beginHostMutation']>[0]): void {
  identity(input);
  if (
    !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
    !input.scope ||
    input.scope.length > 256 ||
    input.scope.includes('\0')
  )
    throw new AgentError('invalid_host_mutation');
  const value = input.safeRequest;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('invalid_host_mutation');
  let allowed: string[];
  if (
    input.kind === 'config.user.write' ||
    input.kind === 'config.workspace.write' ||
    input.kind === 'config.repair'
  ) {
    allowed =
      input.kind === 'config.repair'
        ? ['scope', 'workspaceId', 'ifMatch']
        : ['scope', 'workspaceId', 'ifMatch', 'operationCount', 'modelSettings'];
    if (
      typeof value.ifMatch !== 'string' ||
      value.ifMatch.length > 256 ||
      (input.kind !== 'config.repair' &&
        (typeof value.operationCount !== 'number' ||
          !Number.isSafeInteger(value.operationCount) ||
          value.operationCount < 0 ||
          value.operationCount > 128))
    )
      throw new AgentError('invalid_host_mutation');
    if (value.modelSettings !== undefined) {
      if (value.operationCount !== 1) throw new AgentError('invalid_host_mutation');
      const marker = value.modelSettings;
      if (
        !marker ||
        typeof marker !== 'object' ||
        Array.isArray(marker) ||
        Object.keys(marker).sort().join(',') !== 'expectedReadSet,operation'
      )
        throw new AgentError('invalid_host_mutation');
      const readSet = marker.expectedReadSet;
      const operation = marker.operation;
      if (
        !readSet ||
        typeof readSet !== 'object' ||
        Array.isArray(readSet) ||
        Object.keys(readSet).sort().join(',') !==
          'effectiveDigest,explicitDigest,userEtag,workspaceEtag' ||
        ['effectiveDigest', 'explicitDigest', 'userEtag'].some(
          (key) =>
            typeof readSet[key] !== 'string' || !/^[a-f0-9]{64}$/.test(readSet[key] as string),
        ) ||
        (value.scope === 'user'
          ? readSet.workspaceEtag !== null
          : typeof readSet.workspaceEtag !== 'string' ||
            !/^[a-f0-9]{64}$/.test(readSet.workspaceEtag)) ||
        value.ifMatch !== (value.scope === 'user' ? readSet.userEtag : readSet.workspaceEtag)
      )
        throw new AgentError('invalid_host_mutation');
      if (
        !operation ||
        typeof operation !== 'object' ||
        Array.isArray(operation) ||
        typeof operation.modelId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(operation.modelId) ||
        (operation.kind === 'enabled'
          ? typeof operation.enabled !== 'boolean' ||
            Object.keys(operation).sort().join(',') !== 'enabled,kind,modelId'
          : operation.kind === 'effort'
            ? Object.keys(operation).sort().join(',') !== 'kind,modelId,reasoningEffort' ||
              (operation.reasoningEffort !== null &&
                (typeof operation.reasoningEffort !== 'string' ||
                  !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
                    operation.reasoningEffort,
                  )))
            : operation.kind !== 'default' ||
              Object.keys(operation).sort().join(',') !== 'kind,modelId')
      )
        throw new AgentError('invalid_host_mutation');
    }
    if (
      input.kind === 'config.user.write' ||
      (input.kind === 'config.repair' && value.scope === 'user')
    ) {
      if (value.scope !== 'user' || input.scope !== 'user' || value.workspaceId !== undefined)
        throw new AgentError('invalid_host_mutation');
    } else if (
      value.scope !== 'workspace' ||
      value.workspaceId !== input.scope ||
      !db.row('SELECT id FROM workspace WHERE id=?', input.scope)
    )
      throw new AgentError('invalid_host_mutation');
  } else if (input.kind === 'credential.put' || input.kind === 'credential.revoke') {
    allowed =
      input.kind === 'credential.put'
        ? ['scope', 'persistence']
        : ['scope', 'persistence', 'opaqueRef'];
    if (
      value.scope !== 'user' ||
      input.scope !== 'user' ||
      typeof value.persistence !== 'string' ||
      !['os', 'temporary'].includes(value.persistence)
    )
      throw new AgentError('invalid_host_mutation');
    if (
      input.kind === 'credential.revoke' &&
      (typeof value.opaqueRef !== 'string' || !/^credential:[0-9a-f-]{36}$/.test(value.opaqueRef))
    )
      throw new AgentError('invalid_host_mutation');
  } else if (input.kind === 'permission.mode') {
    allowed = ['scope', 'sessionId', 'mode', 'ifRevision', 'makeDefault', 'ifDefaultRevision'];
    if (
      value.scope !== 'session' ||
      typeof value.sessionId !== 'string' ||
      typeof value.mode !== 'string' ||
      !modes.has(value.mode) ||
      !sequence(value.ifRevision) ||
      !sequence(value.ifDefaultRevision) ||
      typeof value.makeDefault !== 'boolean' ||
      input.scope !== `session:${value.sessionId}` ||
      sessionScope(db, value.sessionId, input.subjectId, true) !== input.scope
    )
      throw new AgentError('invalid_host_mutation');
  } else if (input.kind === 'workspace.trust') {
    allowed = [
      'scope',
      'workspaceId',
      'canonicalIdentity',
      'externalReadScopeDigest',
      'trusted',
      'ifRevision',
    ];
    if (
      value.scope !== 'workspace' ||
      typeof value.workspaceId !== 'string' ||
      input.scope !== `workspace:${value.workspaceId}` ||
      !db.row('SELECT id FROM workspace WHERE id=?', value.workspaceId) ||
      typeof value.canonicalIdentity !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.canonicalIdentity) ||
      typeof value.externalReadScopeDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.externalReadScopeDigest) ||
      typeof value.trusted !== 'boolean' ||
      !sequence(value.ifRevision)
    )
      throw new AgentError('invalid_host_mutation');
  } else throw new AgentError('invalid_host_mutation');
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new AgentError('invalid_host_mutation');
}
function receipt(kind: HostMutationRecord['kind'], state: string, value: Json): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('invalid_host_mutation');
  const keys = kind.startsWith('credential.')
    ? ['status', 'code', 'opaqueRef', 'persistence', 'revoked']
    : ['status', 'code', 'etag'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || Object.keys(value).length === 0)
    throw new AgentError('invalid_host_mutation');
  if (value.status !== undefined && value.status !== state)
    throw new AgentError('invalid_host_mutation');
  if (
    value.code !== undefined &&
    (typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value.code))
  )
    throw new AgentError('invalid_host_mutation');
  if (value.etag !== undefined && (typeof value.etag !== 'string' || value.etag.length > 256))
    throw new AgentError('invalid_host_mutation');
  if (
    value.opaqueRef !== undefined &&
    (typeof value.opaqueRef !== 'string' || !/^credential:[0-9a-f-]{36}$/.test(value.opaqueRef))
  )
    throw new AgentError('invalid_host_mutation');
  if (
    value.persistence !== undefined &&
    (typeof value.persistence !== 'string' || !['os', 'temporary'].includes(value.persistence))
  )
    throw new AgentError('invalid_host_mutation');
  if (value.revoked !== undefined && typeof value.revoked !== 'boolean')
    throw new AgentError('invalid_host_mutation');
}
export function callHostMutation(
  db: SqliteOperations,
  method: 'beginHostMutation' | 'finishHostMutation' | 'getHostMutation' | 'readHostControl',
  args: unknown[],
): unknown {
  if (method === 'readHostControl') {
    const input = args[0] as Parameters<Store['readHostControl']>[0];
    db.db.run('BEGIN');
    try {
      db.identity(input.expectedStoreId);
      if (
        Object.keys(input).some(
          (key) => !['expectedStoreId', 'subjectId', 'kind', 'scope'].includes(key),
        )
      )
        throw new AgentError('invalid_host_control');
      const scoped = { ...input, scope: controlScope(db, input) };
      const found = latestControl(db, scoped);
      const result = {
        revision: String(found?.control_revision ?? '0'),
        record: found ? record(found) : null,
      };
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  if (method === 'getHostMutation') {
    const input = args[0] as Parameters<Store['getHostMutation']>[0];
    db.db.run('BEGIN');
    try {
      db.identity(input.expectedStoreId);
      identity(input);
      const row = db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId);
      if (
        row &&
        (row.subject_id !== input.subjectId || row.origin_store_id !== input.expectedStoreId)
      )
        throw new AgentError('host_mutation_scope_denied');
      db.db.run('COMMIT');
      return row ? record(row) : null;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  if (method === 'beginHostMutation') {
    const input = args[0] as Parameters<Store['beginHostMutation']>[0];
    return db.tx(() => {
      db.identity(input.expectedStoreId);
      safe(db, input);
      const prior = db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId);
      if (prior) {
        if (
          prior.origin_store_id !== input.expectedStoreId ||
          prior.subject_id !== input.subjectId ||
          prior.kind !== input.kind ||
          prior.scope !== input.scope ||
          prior.request_digest !== input.requestDigest ||
          prior.safe_request_json !== canonicalJson(input.safeRequest)
        )
          throw new AgentError('host_mutation_conflict');
        return { created: false, record: record(prior) };
      }
      checkControlRevision(db, input);
      db.run(
        "INSERT INTO host_mutation(id,origin_store_id,subject_id,kind,scope,request_digest,safe_request_json,state) VALUES(?,?,?,?,?,?,?,'pending')",
        input.commandId,
        input.expectedStoreId,
        input.subjectId,
        input.kind,
        input.scope,
        input.requestDigest,
        canonicalJson(input.safeRequest),
      );
      return {
        created: true,
        record: record(db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId)!),
      };
    });
  }
  const input = args[0] as Parameters<Store['finishHostMutation']>[0];
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    identity(input);
    if (
      !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
      !['applied', 'failed', 'outcome_unknown'].includes(input.state) ||
      Buffer.byteLength(canonicalJson(input.receipt)) > 65536
    )
      throw new AgentError('invalid_host_mutation');
    const row = db.row(
      'SELECT rowid AS control_revision,* FROM host_mutation WHERE id=?',
      input.commandId,
    );
    if (
      !row ||
      row.origin_store_id !== input.expectedStoreId ||
      row.subject_id !== input.subjectId ||
      row.request_digest !== input.requestDigest
    )
      throw new AgentError('host_mutation_scope_denied');
    let finalReceipt = input.receipt;
    if (controlKinds.has(String(row.kind))) {
      const supplied = input.receipt;
      if (
        !supplied ||
        typeof supplied !== 'object' ||
        Array.isArray(supplied) ||
        supplied.status !== input.state ||
        Object.keys(supplied).some((key) => !['status', 'code'].includes(key)) ||
        (supplied.code !== undefined &&
          (typeof supplied.code !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(supplied.code)))
      )
        throw new AgentError('invalid_host_mutation');
      const value = JSON.parse(String(row.safe_request_json)) as Record<string, Json>;
      if (input.state === 'applied' && row.state === 'applied') {
        finalReceipt = JSON.parse(String(row.receipt_json)) as Json;
      } else if (input.state === 'applied') {
        if (supplied.code !== undefined) throw new AgentError('invalid_host_mutation');
        if (row.kind === 'permission.mode') {
          finalReceipt = {
            status: 'applied',
            mode: value.mode!,
            revision: String(row.control_revision),
            makeDefault: value.makeDefault!,
            defaultRevision:
              value.makeDefault === true
                ? String(row.control_revision)
                : controlRevision(db, {
                    expectedStoreId: input.expectedStoreId,
                    subjectId: input.subjectId,
                    kind: 'permission.mode',
                    scope: 'user',
                  }),
          };
        } else {
          finalReceipt = {
            status: 'applied',
            trusted: value.trusted!,
            revision: String(row.control_revision),
            canonicalIdentity: value.canonicalIdentity!,
            externalReadScopeDigest: value.externalReadScopeDigest!,
          };
        }
      }
      if (row.state === 'pending' && input.state === 'applied') {
        const original = {
          ...input,
          kind: row.kind as HostMutationRecord['kind'],
          scope: String(row.scope),
          safeRequest: value,
        };
        safe(db, original);
        checkControlRevision(db, original);
      }
    } else receipt(row.kind as HostMutationRecord['kind'], input.state, input.receipt);
    if (row.state !== 'pending') {
      if (row.state !== input.state || row.receipt_json !== canonicalJson(finalReceipt))
        throw new AgentError('host_mutation_terminal_conflict');
      return record(row);
    }
    db.run(
      "UPDATE host_mutation SET state=?,receipt_json=? WHERE id=? AND state='pending'",
      input.state,
      canonicalJson(finalReceipt),
      input.commandId,
    );
    if (controlKinds.has(String(row.kind)) && input.state === 'applied') {
      const value = JSON.parse(String(row.safe_request_json)) as Record<string, Json>;
      db.event(
        row.kind === 'permission.mode' ? String(value.sessionId) : null,
        input.commandId,
        'host_control.changed',
        { kind: String(row.kind), scope: String(row.scope), receipt: finalReceipt },
      );
    }
    return record(db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId)!);
  });
}
