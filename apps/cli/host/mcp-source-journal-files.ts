import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertProfileAccess, type ProfileAccess } from '@kite-ai/agent/profile-access';
import { mcpCanonical } from './mcp-selection-intents';
import type { McpSourceApprovalRecord } from './mcp-source-approval-intents';
import type { McpSourceMutationRecord } from './mcp-source-mutation-intents';

type SourceRecord = McpSourceApprovalRecord | McpSourceMutationRecord;
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
/** Read only. Callers acquire the common data lock before cross-journal prepare checks. */
export function readMcpSourceJournal<T extends SourceRecord>(
  access: ProfileAccess,
  filename: 'mcp-source-approval-intents.json' | 'mcp-source-mutation-intents.json',
  parseRecord: (value: unknown) => T,
  unavailable: () => Error,
): { records: T[]; etag: string | null } {
  assertProfileAccess(access);
  const parent = join(access.profilePath, 'ui'),
    path = join(parent, filename);
  const privateStat = (name: string, directory = false) => {
    const stat = lstatSync(name);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw unavailable();
    return stat;
  };
  privateStat(access.profilePath, true);
  if (present(parent)) privateStat(parent, true);
  if (!present(path)) return { records: [], etag: null };
  const before = privateStat(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.ctimeMs !== before.ctimeMs ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o077) !== 0 ||
      opened.uid !== process.getuid?.() ||
      opened.size > 16 * 1024 * 1024
    )
      throw unavailable();
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      named = privateStat(path);
    if (
      bytes.length !== opened.size ||
      after.ctimeMs !== opened.ctimeMs ||
      after.size !== opened.size ||
      after.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.uid !== opened.uid ||
      after.mode !== opened.mode ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.ctimeMs !== opened.ctimeMs ||
      named.size !== opened.size
    )
      throw unavailable();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
    const doc = value as Record<string, unknown>;
    const keys = Object.keys(doc);
    if (
      keys.length !== 2 ||
      !keys.includes('version') ||
      !keys.includes('records') ||
      doc.version !== 1 ||
      !Array.isArray(doc.records) ||
      doc.records.length > 128
    )
      throw unavailable();
    const ids = new Set<string>();
    const records = doc.records.map((raw) => {
      const record = parseRecord(raw);
      if (ids.has(record.intent.request.commandId)) throw unavailable();
      ids.add(record.intent.request.commandId);
      return record;
    });
    return { records, etag: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** Compare durable original source identities, never current catalogue or Session scopeDigest. */
export function assertMcpSourceJournalAvailable(
  rows: readonly SourceRecord[],
  candidate: SourceRecord,
  conflict: () => Error,
) {
  if (rows.some((row) => row.intent.request.commandId === candidate.intent.request.commandId))
    throw conflict();
  const identities = (record: SourceRecord) => {
    const input = record.intent.request.input,
      read = input.expectedReadSet;
    if ('scope' in input)
      return [input.scope === 'user' ? read.user.identity : read.workspace?.identity].filter(
        Boolean,
      );
    return [read.user.identity, read.workspace?.identity].filter(Boolean);
  };
  const targets = identities(candidate).map(mcpCanonical);
  if (
    rows.some(
      (row) =>
        row.intent.request.expectedStoreId === candidate.intent.request.expectedStoreId &&
        ['submitting', 'pending', 'outcome_unknown'].includes(row.phase) &&
        identities(row).some((identity) => targets.includes(mcpCanonical(identity))),
    )
  )
    throw conflict();
}
