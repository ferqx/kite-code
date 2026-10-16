import { fstatSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { closePrivate, openPrivate, privateDirectory } from './files';
import { MaintenanceError } from './types';

/** Shared private-file envelope; each asset keeps its own closed records codec. */
export function verifyIntentDocument(
  path: string,
  invalid: () => MaintenanceError,
  verifyRecords: (records: unknown) => void,
): void {
  privateDirectory(dirname(path));
  const fd = openPrivate(path);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      (process.platform !== 'win32' && (Number(before.mode) & 0o777) !== 0o600) ||
      before.nlink !== 1n ||
      (process.getuid && before.uid !== BigInt(process.getuid())) ||
      before.size > 16n * 1024n * 1024n
    )
      throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!read) throw invalid();
      offset += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      ['dev', 'ino', 'size', 'ctimeNs', 'mtimeNs', 'mode', 'uid', 'nlink'].some(
        (key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
      )
    )
      throw invalid();
    const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw invalid();
    const row = document as Record<string, unknown>;
    const keys = Object.keys(row);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== 'version' && key !== 'records') ||
      row.version !== 1
    )
      throw invalid();
    verifyRecords(row.records);
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw invalid();
  } finally {
    // This also owns the original Windows pin and preserves an unconfirmed close.
    closePrivate(fd);
  }
}
