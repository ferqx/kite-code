import {
  type WorkingInputRecord,
  type WorkingInputScope,
  workingInputPath,
} from '../../input-working-files';
import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

const namespace = 'builtin.files';
const contentType = 'builtin.files.input-preparation';
const recordKey = (input: WorkingInputScope) =>
  `input-preparation/${input.commandId}/${input.importId}`;
function scope(ops: SqliteOperations, input: WorkingInputScope) {
  ops.identity(input.expectedStoreId);
  if (![input.commandId, input.importId].every((id) => /^[A-Za-z0-9_-]{1,100}$/.test(id)))
    throw new AgentError('input_preparation_invalid');
  const row = ops.row(
    `SELECT s.delete_requested, c.subject_id, w.root_uri
    FROM session s JOIN command c ON c.session_id=s.id AND c.kind='session.create'
    JOIN workspace w ON w.id=s.workspace_id WHERE s.id=?`,
    input.sessionId,
  );
  if (!row || row.subject_id !== input.subjectId || row.delete_requested)
    throw new AgentError('input_file_scope_denied');
  const imported = ops.row(
    'SELECT * FROM input_file_import WHERE id=? AND session_id=? AND subject_id=?',
    input.importId,
    input.sessionId,
    input.subjectId,
  );
  if (
    !imported ||
    imported.origin_store_id !== input.expectedStoreId ||
    imported.state === 'released'
  )
    throw new AgentError('input_file_scope_denied');
  if (imported.state === 'bound' && imported.bound_command_id !== input.commandId)
    throw new AgentError('input_file_already_bound');
  const command = ops.row('SELECT session_id,subject_id FROM command WHERE id=?', input.commandId);
  if (command && (command.session_id !== input.sessionId || command.subject_id !== input.subjectId))
    throw new AgentError('input_preparation_conflict');
  return { rootUri: String(row.root_uri), imported, command };
}
function read(ops: SqliteOperations, input: WorkingInputScope): WorkingInputRecord | null {
  const row = ops.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    namespace,
    input.sessionId,
    recordKey(input),
  );
  if (!row) return null;
  if (
    row.content_type !== contentType ||
    Number(row.content_version) !== 1 ||
    row.origin_store_id !== input.expectedStoreId
  )
    throw new AgentError('input_preparation_conflict');
  return JSON.parse(String(row.json)) as WorkingInputRecord;
}
export function getWorkingInput(
  ops: SqliteOperations,
  input: WorkingInputScope,
): WorkingInputRecord | null {
  ops.db.run('BEGIN');
  try {
    scope(ops, input);
    const result = read(ops, input);
    ops.db.run('COMMIT');
    return result;
  } catch (error) {
    ops.db.run('ROLLBACK');
    throw error;
  }
}
export function registerWorkingInput(
  ops: SqliteOperations,
  input: WorkingInputScope & { record: WorkingInputRecord },
): WorkingInputRecord {
  return ops.tx(() => {
    const actual = scope(ops, input),
      record = input.record,
      old = read(ops, input);
    if (
      record.commandId !== input.commandId ||
      record.importId !== input.importId ||
      record.inputRefId !== `input-file-${input.importId}` ||
      record.workingRelativePath !== workingInputPath(input, String(actual.imported.name)) ||
      record.workspaceRootUri !== actual.rootUri ||
      record.state !== 'ready' ||
      ![record.rootIdentity, record.fileIdentity].every(
        (identity) => identity && /^\d+$/.test(identity.device) && /^\d+$/.test(identity.inode),
      )
    )
      throw new AgentError('input_preparation_invalid');
    if (old) {
      if (
        canonicalJson({ ...old, state: 'ready' } as unknown as Json) !==
        canonicalJson(record as unknown as Json)
      )
        throw new AgentError('input_preparation_conflict');
      return old;
    }
    if (actual.command || actual.imported.state !== 'prepared')
      throw new AgentError('input_preparation_too_late');
    ops.run(
      "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,1,?,1,?,?)",
      namespace,
      input.sessionId,
      recordKey(input),
      contentType,
      input.expectedStoreId,
      canonicalJson(record as unknown as Json),
    );
    ops.event(input.sessionId, `${namespace}/${recordKey(input)}`, 'extension.record_updated');
    return record;
  });
}
/** Called within original input admission: never changes a frozen command afterwards. */
export function bindWorkingInput(ops: SqliteOperations, input: WorkingInputScope): void {
  const record = read(ops, input);
  if (!record) return; // Previously persisted inputs remain readable.
  if (
    record.commandId !== input.commandId ||
    record.importId !== input.importId ||
    !['ready', 'bound'].includes(record.state)
  )
    throw new AgentError('input_preparation_conflict');
  if (record.state === 'bound') return;
  ops.run(
    "UPDATE extension_record SET json=?,revision=revision+1 WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    canonicalJson({ ...record, state: 'bound' } as unknown as Json),
    namespace,
    input.sessionId,
    recordKey(input),
  );
}
