import type { DispatchInput, PermissionControlRead } from '../port';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null | undefined>;
/** Called inside markDispatching's owner transaction; proof never supplies subject or Store identity. */
export function verifyHostControlDispatch(
  db: SqliteOperations,
  execution: Row,
  input: DispatchInput,
): void {
  verifyHostControlReads(db, execution, input.expectedStoreId, input.authorization.controlReads);
}
export function verifyHostControlReads(
  db: SqliteOperations,
  execution: Row,
  expectedStoreId: string,
  reads: readonly PermissionControlRead[] | undefined,
): void {
  if (reads === undefined) return; // Explicit injected policies need not read persistent controls.
  if (!Array.isArray(reads) || reads.length > 3)
    throw new AgentError('invalid_permission_control_reads');
  if (!reads.length) return;
  const command = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
  const session = db.row('SELECT * FROM session WHERE id=?', execution.session_id!);
  const root =
    session && db.row('SELECT * FROM session WHERE id=? AND parent_id IS NULL', session.root_id!);
  const commandSession = command && db.row('SELECT * FROM session WHERE id=?', command.session_id!);
  if (
    !command ||
    !session ||
    !root ||
    !commandSession ||
    command.origin_store_id !== expectedStoreId ||
    execution.origin_store_id !== expectedStoreId ||
    commandSession.root_id !== root.id ||
    commandSession.workspace_id !== session.workspace_id ||
    root.workspace_id !== session.workspace_id
  )
    throw new AgentError('permission_control_scope_denied');
  const seen = new Set<string>();
  for (const read of reads) {
    if (
      !read ||
      typeof read !== 'object' ||
      Array.isArray(read) ||
      Object.keys(read).some((key) => !['kind', 'scope', 'revision'].includes(key)) ||
      !['permission.mode', 'workspace.trust'].includes(read.kind) ||
      typeof read.scope !== 'string' ||
      read.scope.length < 1 ||
      read.scope.length > 256 ||
      typeof read.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(read.revision) ||
      BigInt(read.revision) > 9223372036854775807n
    )
      throw new AgentError('invalid_permission_control_reads');
    const identity = JSON.stringify([read.kind, read.scope]);
    if (seen.has(identity)) throw new AgentError('invalid_permission_control_reads');
    seen.add(identity);
    if (read.kind === 'permission.mode') {
      if (read.scope !== 'user' && read.scope !== `session:${root.id}`)
        throw new AgentError('permission_control_scope_denied');
      if (read.scope !== 'user') {
        const creator = db.row(
          "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
          root.id!,
        );
        if (!creator || creator.subject_id !== command.subject_id)
          throw new AgentError('permission_control_scope_denied');
      }
    } else if (read.scope !== `workspace:${session.workspace_id}`)
      throw new AgentError('permission_control_scope_denied');
    // Same definition as readHostControl, including user default selected across roots.
    const current =
      read.kind === 'permission.mode' && read.scope === 'user'
        ? db.row(
            "SELECT rowid AS revision FROM host_mutation WHERE origin_store_id=? AND subject_id=? AND kind='permission.mode' AND state='applied' AND json_extract(safe_request_json,'$.makeDefault')=1 ORDER BY rowid DESC LIMIT 1",
            expectedStoreId,
            command.subject_id!,
          )
        : db.row(
            "SELECT rowid AS revision FROM host_mutation WHERE origin_store_id=? AND subject_id=? AND kind=? AND scope=? AND state='applied' ORDER BY rowid DESC LIMIT 1",
            expectedStoreId,
            command.subject_id!,
            read.kind,
            read.scope,
          );
    if (String(current?.revision ?? '0') !== read.revision)
      throw new AgentError('permission_control_changed');
  }
}
