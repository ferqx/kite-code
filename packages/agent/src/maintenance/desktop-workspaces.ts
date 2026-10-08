import type { Database } from 'bun:sqlite';
import { MaintenanceError } from './types';

/** Closed DB8 caller metadata; restoration copies original identities and never executes them. */
export function verifyDesktopWorkspaceRows(db: Database) {
  let count = 0,
    bytes = 0;
  const scopes = new Set<string>();
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  try {
    for (const r of db
      .query<{ command_id: string; state: string; state_hex: string }, []>(
        'SELECT command_id,state,hex(CAST(state AS BLOB)) AS state_hex FROM workspace_removal_intents',
      )
      .iterate()) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(r.state_hex, 'hex'),
      );
      const intent = JSON.parse(text);
      if (
        text !== r.state ||
        !intent ||
        Object.keys(intent).sort().join(',') !== 'label,phase,request,subjectId,workspaceId' ||
        !intent.request ||
        Object.keys(intent.request).sort().join(',') !== 'commandId,expectedStoreId' ||
        ![intent.request.commandId, intent.request.expectedStoreId, intent.workspaceId].every(id) ||
        intent.request.commandId !== r.command_id ||
        typeof intent.subjectId !== 'string' ||
        !intent.subjectId ||
        intent.subjectId.length > 256 ||
        typeof intent.label !== 'string' ||
        intent.label.length > 512 ||
        !['submitting', 'unknown'].includes(intent.phase)
      )
        throw Error();
      const scope = JSON.stringify([intent.request.expectedStoreId, intent.workspaceId]);
      bytes += Buffer.byteLength(text);
      if (scopes.has(scope) || ++count > 128 || bytes > 262144) throw Error();
      scopes.add(scope);
    }
  } catch {
    throw new MaintenanceError('backup_ui_invalid');
  }
}
