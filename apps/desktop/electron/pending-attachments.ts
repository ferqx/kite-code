import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  NativeAttachmentRecovery,
  NativePendingAttachment,
  NativePendingAttachments,
} from '../src/input-images-bridge';
import type { NativeCallerRecord } from '../src/native-bridge';
import type { DraftScope } from './private-data';

export const pendingAttachmentSchemas = [
  'CREATE TABLE pending_attachment_deleted_sessions(store_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(store_id,session_id))',
  'CREATE TABLE pending_attachment_drafts(id TEXT PRIMARY KEY,store_id TEXT NOT NULL,workspace_id TEXT NOT NULL,session_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,entries TEXT NOT NULL)',
  'CREATE TABLE pending_attachment_chunks(draft_id TEXT NOT NULL,attachment_id TEXT NOT NULL,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(draft_id,attachment_id,offset))',
  'CREATE TABLE pending_attachment_commands(command_id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,revision INTEGER NOT NULL,session_id TEXT NOT NULL,workspace_id TEXT NOT NULL,ids TEXT NOT NULL,entries TEXT NOT NULL)',
] as const;
export type StoredPendingAttachment = NativePendingAttachment & { chunks?: readonly Uint8Array[] };
export type NativeAttachmentProof = {
  recovery?: NativeAttachmentRecovery;
  sessionId: string;
  workspaceId: string;
  revision: number;
  ids: string[];
};
export interface NativePendingAttachmentData {
  read(scope: DraftScope, verifyBytes?: boolean): NativePendingAttachments;
  capture(
    scope: DraftScope,
    revision: number,
    imageIds: readonly string[],
    fileIds: readonly string[],
    references?: readonly { name: string; uri: string }[],
  ): (commandId: string) => void;
  save(
    scope: DraftScope,
    revision: number,
    entries: readonly StoredPendingAttachment[],
  ): NativePendingAttachments;
  readBytes(scope: DraftScope, id: string): Uint8Array[];
  move(
    source: DraftScope,
    revision: number,
    target: DraftScope,
    targetRevision: number,
  ): NativePendingAttachments;
  bind(
    commandId: string,
    scope: DraftScope,
    revision: number,
    imageIds: readonly string[],
    fileIds: readonly string[],
    references?: readonly { name: string; uri: string }[],
  ): void;
  proof(commandId: string): NativeAttachmentProof | undefined;
  consume(record: NativeCallerRecord): void;
  recoveryItems(commandId: string): NativePendingAttachment[] | undefined;
  recover(record: NativeCallerRecord, items: readonly StoredPendingAttachment[]): void;
  recoveryFailed(record: NativeCallerRecord, error: string): void;
  recoveryNotNeeded(record: NativeCallerRecord): void;
  clearCommand(commandId: string): void;
  deleteSession(storeId: string, sessionId: string): void;
}
const limit = 320 * 1024 * 1024;
const sameAttachment = (a: NativePendingAttachment, b: NativePendingAttachment) =>
  (['id', 'kind', 'name', 'state', 'mediaType', 'size', 'hash', 'uri', 'error'] as const).every(
    (field) => a[field] === b[field],
  );
const validId = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const key = (scope: DraftScope) => {
  if (
    !Object.values(scope).every(validId) ||
    Object.keys(scope).sort().join(',') !== 'rootSessionId,storeId,workspaceId'
  )
    throw Error('attachment_scope_unavailable');
  return createHash('sha256')
    .update(JSON.stringify([scope.storeId, scope.workspaceId, scope.rootSessionId]))
    .digest('hex');
};
function metadata(raw: StoredPendingAttachment): NativePendingAttachment {
  const { chunks: _chunks, ...entry } = raw;
  if (
    !validId(entry.id) ||
    !['image', 'file', 'reference'].includes(entry.kind) ||
    typeof entry.name !== 'string' ||
    !entry.name ||
    Buffer.byteLength(entry.name) > 4096 ||
    !['ready', 'error'].includes(entry.state) ||
    Object.keys(entry).some(
      (field) =>
        !['id', 'kind', 'name', 'state', 'mediaType', 'size', 'hash', 'uri', 'error'].includes(
          field,
        ),
    ) ||
    (entry.error !== undefined && (typeof entry.error !== 'string' || entry.error.length > 1024))
  )
    throw Error('attachment_metadata_invalid');
  if (entry.kind === 'reference') {
    if (
      typeof entry.uri !== 'string' ||
      entry.uri.length > 32768 ||
      !entry.uri.startsWith('file:') ||
      new URL(entry.uri).protocol !== 'file:'
    )
      throw Error('attachment_metadata_invalid');
  } else if (entry.state === 'ready') {
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size! < 0 ||
      entry.size! > (entry.kind === 'image' ? 16 : 256) * 1024 * 1024 ||
      typeof entry.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      typeof entry.mediaType !== 'string' ||
      !entry.mediaType ||
      entry.mediaType.length > 256 ||
      (entry.kind === 'image' &&
        (!entry.size ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(entry.mediaType)))
    )
      throw Error('attachment_metadata_invalid');
  }
  return entry;
}
type BindingState = {
  items: NativePendingAttachment[];
  consumed?: boolean;
  recovery?: NativeAttachmentRecovery;
};
function bindingState(value: unknown): BindingState {
  const parsed = JSON.parse(String(value));
  const state = Array.isArray(parsed) ? { items: parsed } : parsed;
  if (!state || !Array.isArray(state.items) || state.items.length > 128)
    throw Error('attachment_storage_unavailable');
  return { ...state, items: state.items.map(metadata) };
}
/** Shares the protected UI SQLite transaction with caller receipts. No paths or auto-submit. */
export function createPendingAttachments(
  database: () => DatabaseSync,
  transaction: <T>(fn: () => T) => T,
  ensure: () => void,
): NativePendingAttachmentData {
  let transactionDepth = 0;
  const atomic = <T>(action: () => T): T => {
    if (transactionDepth) return action();
    return transaction(() => {
      transactionDepth++;
      try {
        return action();
      } finally {
        transactionDepth--;
      }
    });
  };
  const stateFor = (commandId: string) =>
    exists()
      ? database()
          .prepare('SELECT entries FROM pending_attachment_commands WHERE command_id=?')
          .get(commandId)
      : undefined;
  const updateRecovery = (record: NativeCallerRecord, recovery: NativeAttachmentRecovery) => {
    const row = stateFor(record.intent.request.commandId);
    if (!row) return;
    const state = bindingState(row.entries);
    if (state.recovery?.phase === 'restored' || state.recovery?.phase === 'not_needed') return;
    database()
      .prepare('UPDATE pending_attachment_commands SET entries=? WHERE command_id=?')
      .run(JSON.stringify({ ...state, recovery }), record.intent.request.commandId);
  };
  const exists = () => Number(database().prepare('PRAGMA user_version').get()!.user_version) >= 13;
  function row(scope: DraftScope) {
    const id = key(scope);
    if (!exists()) return { id, revision: 0, deleted: 0, entries: '[]' };
    return (
      database()
        .prepare('SELECT id,revision,deleted,entries FROM pending_attachment_drafts WHERE id=?')
        .get(id) ?? { id, revision: 0, deleted: 0, entries: '[]' }
    );
  }
  function entries(scope: DraftScope) {
    const saved = row(scope);
    if (
      exists() &&
      database()
        .prepare(
          'SELECT session_id FROM pending_attachment_deleted_sessions WHERE store_id=? AND session_id=?',
        )
        .get(scope.storeId, scope.rootSessionId)
    )
      throw Error('attachment_scope_unavailable');
    if (saved.deleted) throw Error('attachment_scope_unavailable');
    if (
      !Number.isSafeInteger(saved.revision) ||
      Number(saved.revision) < 0 ||
      typeof saved.entries !== 'string' ||
      Buffer.byteLength(saved.entries) > 1048576
    )
      throw Error('attachment_storage_unavailable');
    const values: unknown = JSON.parse(saved.entries);
    if (!Array.isArray(values) || values.length > 128)
      throw Error('attachment_storage_unavailable');
    const items = values.map((entry) => metadata(entry));
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw Error('attachment_storage_unavailable');
    return { id: String(saved.id), revision: Number(saved.revision), items };
  }
  function bytes(scope: DraftScope, id: string): Uint8Array[] {
    const saved = entries(scope),
      item = saved.items.find((entry) => entry.id === id);
    if (item?.state !== 'ready' || item.kind === 'reference')
      throw Error('attachment_bytes_unavailable');
    const storedSizes = database()
      .prepare(
        'SELECT count(*) AS count,coalesce(sum(length(bytes)),0) AS size,coalesce(max(length(bytes)),0) AS maximum FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?',
      )
      .get(saved.id, id)!;
    if (
      Number(storedSizes.size) !== item.size ||
      Number(storedSizes.maximum) > 65536 ||
      Number(storedSizes.count) > 8192
    )
      throw Error('attachment_bytes_unavailable');
    const chunks: Uint8Array[] = [],
      digest = createHash('sha256');
    let offset = 0;
    for (const chunk of database()
      .prepare(
        'SELECT offset,bytes FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=? ORDER BY offset',
      )
      .iterate(saved.id, id)) {
      if (
        chunk.offset !== offset ||
        !(chunk.bytes instanceof Uint8Array) ||
        !chunk.bytes.byteLength ||
        chunk.bytes.byteLength > 65536 ||
        offset + chunk.bytes.byteLength > item.size!
      )
        throw Error('attachment_bytes_unavailable');
      chunks.push(chunk.bytes);
      digest.update(chunk.bytes);
      offset += chunk.bytes.byteLength;
    }
    if (offset !== item.size || digest.digest('hex') !== item.hash)
      throw Error('attachment_bytes_unavailable');
    return chunks;
  }
  function read(scope: DraftScope, verifyBytes = true): NativePendingAttachments {
    const saved = entries(scope);
    return {
      kind: 'input.attachments',
      revision: saved.revision,
      attachments: saved.items.map((item) => {
        if (verifyBytes && item.state === 'ready' && item.kind !== 'reference') {
          try {
            bytes(scope, item.id);
          } catch {
            return { ...item, state: 'error', error: 'attachment_bytes_unavailable' };
          }
        }
        return item;
      }),
    };
  }
  const api: NativePendingAttachmentData = {
    read,
    readBytes: bytes,
    save(scope, revision, input) {
      const items = input.map(metadata);
      if (
        items.length > 128 ||
        new Set(items.map((item) => item.id)).size !== items.length ||
        items.filter((item) => item.kind === 'image').length > 10 ||
        Buffer.byteLength(JSON.stringify(items)) > 1048576
      )
        throw Error('attachment_capacity_exceeded');
      return atomic(() => {
        ensure();
        const saved = entries(scope);
        if (saved.revision !== revision || !Number.isSafeInteger(revision + 1))
          throw Error('attachment_revision_conflict');
        const count = Number(
          database().prepare('SELECT count(*) AS count FROM pending_attachment_drafts').get()!
            .count,
        );
        if (
          !database()
            .prepare('SELECT id FROM pending_attachment_drafts WHERE id=?')
            .get(saved.id) &&
          count >= 4096
        )
          throw Error('attachment_capacity_exceeded');
        const metadataBytes = Number(
          database()
            .prepare(
              'SELECT coalesce(sum(length(CAST(entries AS BLOB))),0) AS total FROM pending_attachment_drafts WHERE id<>?',
            )
            .get(saved.id)!.total,
        );
        if (metadataBytes + Buffer.byteLength(JSON.stringify(items)) > 16 * 1024 * 1024)
          throw Error('attachment_capacity_exceeded');
        let total = Number(
            database()
              .prepare(
                'SELECT coalesce(sum(length(bytes)),0) AS total FROM pending_attachment_chunks WHERE draft_id<>?',
              )
              .get(saved.id)!.total,
          ),
          imageTotal = 0,
          fileTotal = 0;
        const prepared = input.map((entry, index) => {
          const item = items[index]!;
          if (item.state !== 'ready' || item.kind === 'reference') return [];
          const unchanged = saved.items.some((previous) => sameAttachment(previous, item));
          if (unchanged) {
            const existing = database()
              .prepare(
                'SELECT coalesce(sum(length(bytes)),0) AS size,count(*) AS count FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?',
              )
              .get(saved.id, item.id)!;
            if (Number(existing.size) !== item.size || Number(existing.count) > 8192)
              throw Error('attachment_bytes_unavailable');
            total += item.size!;
            if (item.kind === 'image') imageTotal += item.size!;
            else fileTotal += item.size!;
            return null;
          }
          const chunks = entry.chunks ?? bytes(scope, item.id),
            digest = createHash('sha256');
          let size = 0;
          if (chunks.length > 8192) throw Error('attachment_capacity_exceeded');
          for (const chunk of chunks) {
            if (!(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > 65536)
              throw Error('attachment_bytes_unavailable');
            digest.update(chunk);
            size += chunk.byteLength;
          }
          if (size !== item.size || digest.digest('hex') !== item.hash)
            throw Error('attachment_bytes_unavailable');
          total += size;
          if (item.kind === 'image') imageTotal += size;
          else fileTotal += size;
          return chunks;
        });
        if (total > limit || imageTotal > 64 * 1024 * 1024 || fileTotal > 256 * 1024 * 1024)
          throw Error('attachment_capacity_exceeded');
        for (const previous of saved.items) {
          const index = items.findIndex((item) => item.id === previous.id);
          if (index < 0 || prepared[index] !== null)
            database()
              .prepare('DELETE FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?')
              .run(saved.id, previous.id);
        }
        database()
          .prepare(
            'INSERT INTO pending_attachment_drafts VALUES(?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,entries=excluded.entries',
          )
          .run(
            saved.id,
            scope.storeId,
            scope.workspaceId,
            scope.rootSessionId,
            revision + 1,
            JSON.stringify(items),
          );
        for (let index = 0; index < items.length; index++) {
          if (prepared[index] === null) continue;
          let offset = 0;
          for (const chunk of prepared[index]!) {
            database()
              .prepare('INSERT INTO pending_attachment_chunks VALUES(?,?,?,?)')
              .run(saved.id, items[index]!.id, offset, chunk);
            offset += chunk.byteLength;
          }
        }
        return { kind: 'input.attachments' as const, revision: revision + 1, attachments: items };
      });
    },
    move(source, revision, target, targetRevision) {
      if (
        source.storeId !== target.storeId ||
        source.workspaceId !== target.workspaceId ||
        source.rootSessionId !== 'new-conversation' ||
        target.rootSessionId === source.rootSessionId
      )
        throw Error('attachment_scope_unavailable');
      return atomic(() => {
        ensure();
        const from = entries(source),
          to = entries(target);
        if (
          from.revision !== revision ||
          to.revision !== targetRevision ||
          !Number.isSafeInteger(revision + 1) ||
          !Number.isSafeInteger(targetRevision + 1)
        )
          throw Error('attachment_revision_conflict');
        const combined = [...to.items];
        for (const item of from.items) {
          const duplicate = combined.find((entry) => entry.id === item.id);
          if (duplicate && !sameAttachment(duplicate, item))
            throw Error('attachment_revision_conflict');
          if (!duplicate) combined.push(item);
        }
        if (
          combined.length > 128 ||
          combined.filter((item) => item.kind === 'image').length > 10 ||
          Buffer.byteLength(JSON.stringify(combined)) > 1048576 ||
          combined
            .filter((item) => item.state === 'ready' && item.kind === 'image')
            .reduce((sum, item) => sum + item.size!, 0) >
            64 * 1024 * 1024 ||
          combined
            .filter((item) => item.state === 'ready' && item.kind === 'file')
            .reduce((sum, item) => sum + item.size!, 0) >
            256 * 1024 * 1024
        )
          throw Error('attachment_capacity_exceeded');
        const newRows = [from.id, to.id].filter(
          (id) =>
            !database().prepare('SELECT id FROM pending_attachment_drafts WHERE id=?').get(id),
        ).length;
        if (
          Number(
            database().prepare('SELECT count(*) AS count FROM pending_attachment_drafts').get()!
              .count,
          ) +
            newRows >
          4096
        )
          throw Error('attachment_capacity_exceeded');
        for (const binding of database()
          .prepare('SELECT command_id FROM pending_attachment_commands WHERE draft_id=?')
          .all(from.id)) {
          const caller = database()
            .prepare('SELECT state FROM caller_intents WHERE command_id=?')
            .get(binding.command_id!);
          if (
            !caller ||
            JSON.parse(String(caller.state)).intent.scope.sessionId !== target.rootSessionId
          )
            throw Error('attachment_scope_unavailable');
        }
        for (const [scope, id, next, items] of [
          [source, from.id, revision + 1, []],
          [target, to.id, targetRevision + 1, combined],
        ] as const)
          database()
            .prepare(
              'INSERT INTO pending_attachment_drafts VALUES(?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,entries=excluded.entries',
            )
            .run(
              id,
              scope.storeId,
              scope.workspaceId,
              scope.rootSessionId,
              next,
              JSON.stringify(items),
            );
        for (const item of from.items) {
          if (to.items.some((entry) => entry.id === item.id))
            database()
              .prepare('DELETE FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?')
              .run(from.id, item.id);
          else
            database()
              .prepare(
                'UPDATE pending_attachment_chunks SET draft_id=? WHERE draft_id=? AND attachment_id=?',
              )
              .run(to.id, from.id, item.id);
        }
        database()
          .prepare(
            'UPDATE pending_attachment_commands SET draft_id=?,session_id=?,revision=? WHERE draft_id=?',
          )
          .run(to.id, target.rootSessionId, targetRevision + 1, from.id);
        return { ...read(target), sourceRevision: revision + 1 };
      });
    },
    bind(commandId, scope, revision, imageIds, fileIds, references = []) {
      api.capture(scope, revision, imageIds, fileIds, references)(commandId);
    },
    capture(scope, revision, imageIds, fileIds, references = []) {
      const saved = entries(scope);
      const submitted = saved.items.filter((item) =>
        item.kind === 'image'
          ? imageIds.includes(item.id)
          : item.kind === 'file'
            ? fileIds.includes(item.id)
            : references.some((ref) => ref.uri === item.uri && ref.name === item.name),
      );
      if (saved.revision !== revision || submitted.some((item) => item.state !== 'ready'))
        throw Error('attachment_revision_conflict');
      const ids = JSON.stringify(submitted.map((item) => item.id));
      const boundEntries = JSON.stringify(submitted);
      // Capture before asynchronous publication. Later edits own a new revision, not this send.
      return (commandId) =>
        atomic(() => {
          ensure();
          entries(scope); // An intervening deletion revokes even the frozen batch.
          const previous = database()
            .prepare('SELECT * FROM pending_attachment_commands WHERE command_id=?')
            .get(commandId);
          if (previous) {
            if (
              previous.draft_id !== saved.id ||
              previous.revision !== revision ||
              previous.ids !== ids ||
              previous.entries !== boundEntries
            )
              throw Error('attachment_revision_conflict');
            return;
          }
          if (
            Number(
              database().prepare('SELECT count(*) AS count FROM pending_attachment_commands').get()!
                .count,
            ) >= 256
          )
            throw Error('attachment_capacity_exceeded');
          database()
            .prepare('INSERT INTO pending_attachment_commands VALUES(?,?,?,?,?,?,?)')
            .run(
              commandId,
              saved.id,
              revision,
              scope.rootSessionId,
              scope.workspaceId,
              ids,
              boundEntries,
            );
        });
    },
    proof(commandId) {
      if (!exists()) return;
      const proof = database()
        .prepare('SELECT * FROM pending_attachment_commands WHERE command_id=?')
        .get(commandId);
      if (!proof) return;
      return {
        sessionId: String(proof.session_id),
        workspaceId: String(proof.workspace_id),
        revision: Number(proof.revision),
        ids: JSON.parse(String(proof.ids)),
        ...(bindingState(proof.entries).recovery
          ? { recovery: bindingState(proof.entries).recovery }
          : {}),
      };
    },
    consume(record) {
      if (!exists() || !['accepted', 'applied', 'rejected'].includes(record.phase)) return;
      const binding = database()
        .prepare('SELECT * FROM pending_attachment_commands WHERE command_id=?')
        .get(record.intent.request.commandId);
      if (!binding) return;
      const boundState = bindingState(binding.entries);
      if (record.phase === 'rejected') {
        // This marker shares the receipt transaction. A crash before Artifact reads
        // must leave the cold renderer blocked with a reachable read-only retry.
        if (boundState.consumed && boundState.items.length)
          updateRecovery(record, {
            phase: 'unavailable',
            sessionId: record.intent.scope.sessionId,
            workspaceId: record.intent.scope.workspaceId,
            error: 'attachment_recovery_pending',
          });
        return;
      }
      if (boundState.consumed) {
        if (record.phase === 'applied')
          updateRecovery(record, {
            phase: 'not_needed',
            sessionId: record.intent.scope.sessionId,
            workspaceId: record.intent.scope.workspaceId,
          });
        return;
      }
      const draft = database()
        .prepare('SELECT * FROM pending_attachment_drafts WHERE id=?')
        .get(binding.draft_id!);
      const valid =
        draft &&
        !draft.deleted &&
        Number(draft.revision) >= Number(binding.revision) &&
        draft.store_id === record.intent.scope.storeId &&
        (draft.session_id === 'new-conversation' ||
          draft.session_id === record.intent.scope.sessionId) &&
        draft.workspace_id === record.intent.scope.workspaceId;
      const latest = valid
        ? entries({
            storeId: String(draft.store_id),
            workspaceId: String(draft.workspace_id),
            rootSessionId: String(draft.session_id),
          })
        : undefined;
      // Only bytes actually removed by this receipt may later be restored. A user
      // removal or same-ID replacement during submission must remain their choice.
      const consumed = boundState.items.filter((original) =>
        latest?.items.some((item) => sameAttachment(item, original)),
      );
      database()
        .prepare('UPDATE pending_attachment_commands SET entries=? WHERE command_id=?')
        .run(
          JSON.stringify({
            ...boundState,
            items: consumed,
            consumed: true,
            ...(record.phase === 'applied' || !consumed.length
              ? {
                  recovery: {
                    phase: 'not_needed',
                    sessionId: record.intent.scope.sessionId,
                    workspaceId: record.intent.scope.workspaceId,
                  },
                }
              : {}),
          }),
          record.intent.request.commandId,
        );
      if (!latest || !consumed.length) return;
      const remaining = latest.items.filter(
        (item) => !consumed.some((original) => sameAttachment(item, original)),
      );
      if (!Number.isSafeInteger(latest.revision + 1)) throw Error('attachment_revision_conflict');
      database()
        .prepare(
          'UPDATE pending_attachment_drafts SET revision=revision+1,entries=? WHERE id=? AND revision=?',
        )
        .run(JSON.stringify(remaining), latest.id, latest.revision);
      for (const item of latest.items)
        if (!remaining.includes(item))
          database()
            .prepare('DELETE FROM pending_attachment_chunks WHERE draft_id=? AND attachment_id=?')
            .run(latest.id, item.id);
    },
    recoveryItems(commandId) {
      const row = stateFor(commandId);
      if (!row) return;
      const state = bindingState(row.entries);
      if (
        !state.consumed ||
        !state.items.length ||
        state.recovery?.phase === 'restored' ||
        state.recovery?.phase === 'not_needed'
      )
        return;
      return structuredClone(state.items);
    },
    recover(record, recovered) {
      if (record.phase !== 'rejected') throw Error('attachment_recovery_unverified');
      atomic(() => {
        const originals = api.recoveryItems(record.intent.request.commandId);
        if (!originals) return;
        if (recovered.length !== originals.length) throw Error('attachment_recovery_unverified');
        for (let i = 0; i < recovered.length; i++) {
          const item = recovered[i]!,
            original = originals[i]!;
          if (
            item.id === original.id ||
            !sameAttachment({ ...metadata(item), id: original.id }, original)
          )
            throw Error('attachment_recovery_unverified');
        }
        const scope = {
          storeId: record.intent.scope.storeId,
          workspaceId: record.intent.scope.workspaceId,
          rootSessionId: record.intent.scope.sessionId,
        };
        const current = entries(scope),
          merged: StoredPendingAttachment[] = [...current.items];
        for (const item of recovered) {
          const existing = merged.find((entry) => entry.id === item.id);
          if (existing && !sameAttachment(existing, item))
            throw Error('attachment_revision_conflict');
          if (!existing) merged.push(item);
        }
        const saved = api.save(scope, current.revision, merged);
        updateRecovery(record, {
          phase: 'restored',
          sessionId: scope.rootSessionId,
          workspaceId: scope.workspaceId,
          revision: saved.revision,
          ids: recovered.map((item) => item.id),
        });
      });
    },
    recoveryFailed(record, error) {
      if (record.phase !== 'rejected') return;
      atomic(() =>
        updateRecovery(record, {
          phase: 'unavailable',
          sessionId: record.intent.scope.sessionId,
          workspaceId: record.intent.scope.workspaceId,
          error: /^[a-z][a-z0-9_]{0,80}$/.test(error) ? error : 'attachment_recovery_unavailable',
        }),
      );
    },
    recoveryNotNeeded(record) {
      atomic(() =>
        updateRecovery(record, {
          phase: 'not_needed',
          sessionId: record.intent.scope.sessionId,
          workspaceId: record.intent.scope.workspaceId,
        }),
      );
    },
    clearCommand(commandId) {
      if (api.recoveryItems(commandId)) throw Error('attachment_recovery_unresolved');
      if (exists())
        database()
          .prepare('DELETE FROM pending_attachment_commands WHERE command_id=?')
          .run(commandId);
    },
    deleteSession(storeId, sessionId) {
      if (!validId(storeId) || !validId(sessionId)) throw Error('attachment_scope_unavailable');
      atomic(() => {
        ensure();
        if (
          !database()
            .prepare(
              'SELECT session_id FROM pending_attachment_deleted_sessions WHERE store_id=? AND session_id=?',
            )
            .get(storeId, sessionId) &&
          Number(
            database()
              .prepare('SELECT count(*) AS count FROM pending_attachment_deleted_sessions')
              .get()!.count,
          ) >= 65536
        )
          throw Error('attachment_capacity_exceeded');
        database()
          .prepare('INSERT OR IGNORE INTO pending_attachment_deleted_sessions VALUES(?,?)')
          .run(storeId, sessionId);
        for (const draft of database()
          .prepare('SELECT id FROM pending_attachment_drafts WHERE store_id=? AND session_id=?')
          .all(storeId, sessionId)) {
          database()
            .prepare(
              "UPDATE pending_attachment_drafts SET revision=revision+1,deleted=1,entries='[]' WHERE id=? AND deleted=0",
            )
            .run(draft.id!);
          database()
            .prepare('DELETE FROM pending_attachment_chunks WHERE draft_id=?')
            .run(draft.id!);
        }
      });
    },
  };
  return api;
}
