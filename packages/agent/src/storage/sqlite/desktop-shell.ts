import { AgentError, type DesktopShellBackend, type DesktopShellPreference } from '../types';
import type { SqliteOperations } from './operations';

// Private host records are outside the session extension and Fork namespaces.
function read(db: SqliteOperations, id: string, key: 'preference' | 'backend'): unknown {
  const row = db.row(
    `SELECT json,content_version,origin_store_id FROM extension_record
     WHERE extension_id='host.desktop-shell' AND scope_kind='host' AND scope_id=? AND key=?`,
    id,
    key,
  );
  if (!row) return undefined;
  if (row.origin_store_id !== null || Number(row.content_version) !== 1)
    throw new AgentError('desktop_shell_state_invalid');
  return JSON.parse(String(row.json));
}

export function readDesktopShellPreference(db: SqliteOperations, expectedStoreId: string) {
  db.identity(expectedStoreId);
  const value = read(db, expectedStoreId, 'preference');
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'git-bash' || value === 'powershell') return value;
  throw new AgentError('desktop_shell_state_invalid');
}

export function saveDesktopShellPreference(
  db: SqliteOperations,
  expectedStoreId: string,
  preference: DesktopShellPreference,
) {
  db.tx(() => {
    db.identity(expectedStoreId);
    if (preference !== 'auto' && preference !== 'git-bash' && preference !== 'powershell')
      throw new AgentError('desktop_shell_preference_invalid');
    db.run(
      `INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json)
       VALUES('host.desktop-shell','host',?,'preference',1,'application/json',1,NULL,?)
       ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET
         revision=revision+1,json=excluded.json WHERE json<>excluded.json`,
      expectedStoreId,
      JSON.stringify(preference),
    );
  });
}

/** Called in the creation transaction after the original command replay check. */
export function bindDesktopShell(
  db: SqliteOperations,
  storeId: string,
  rootSessionId: string,
  automatic: DesktopShellBackend | undefined,
) {
  if (automatic === undefined) return;
  const preference = readDesktopShellPreference(db, storeId);
  const value = preference === 'auto' ? automatic : preference;
  if (value !== 'git-bash' && value !== 'powershell' && value !== 'unavailable')
    throw new AgentError('desktop_shell_state_invalid');
  db.run(
    `INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json)
     VALUES('host.desktop-shell','host',?,'backend',1,'application/json',1,NULL,?)`,
    rootSessionId,
    JSON.stringify(value),
  );
}

export function readSessionDesktopShell(db: SqliteOperations, rootSessionId: string) {
  const value = read(db, rootSessionId, 'backend');
  if (value === undefined) return null;
  if (value === 'git-bash' || value === 'powershell' || value === 'unavailable') return value;
  throw new AgentError('desktop_shell_state_invalid');
}
