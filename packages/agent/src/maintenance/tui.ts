import { createHash } from 'node:crypto';
import { fstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closePrivate as closeSync, openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';
/** Exact owner v1 JSON contract. Text and original associations are never re-labelled. */
export function verifyTuiDocument(path: string) {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    if (fstatSync(fd).size > 16 * 1024 * 1024) throw new MaintenanceError('backup_tui_invalid');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
    const closed = (value: unknown, keys: string[]): value is Record<string, unknown> =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.sort().join(',');
    const revision = (value: unknown) =>
      typeof value === 'string' &&
      value.length <= 19 &&
      /^(0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) <= 9223372036854775807n;
    if (
      !closed(value, ['version', 'revision', 'drafts']) ||
      value.version !== 1 ||
      !revision(value.revision) ||
      !Array.isArray(value.drafts) ||
      value.drafts.length > 4096
    )
      throw new MaintenanceError('backup_tui_invalid');
    const ids = new Set<string>();
    for (const row of value.drafts) {
      if (
        !closed(row, ['id', 'storeId', 'workspaceId', 'sessionId', 'revision', 'text']) ||
        typeof row.text !== 'string' ||
        !revision(row.revision) ||
        ![row.storeId, row.workspaceId, row.sessionId].every(
          (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id),
        )
      )
        throw new MaintenanceError('backup_tui_invalid');
      const id = createHash('sha256')
        .update(JSON.stringify([row.storeId, row.workspaceId, row.sessionId]))
        .digest('hex');
      if (row.id !== id || ids.has(id)) throw new MaintenanceError('backup_tui_invalid');
      ids.add(id);
    }
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError('backup_tui_invalid');
  } finally {
    closeSync(fd);
  }
}
