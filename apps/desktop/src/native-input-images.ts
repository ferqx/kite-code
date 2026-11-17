import type { ImagePreviewSource } from '@kite-ai/ui/desktop';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import {
  encodeInputImageChunk,
  hashInputImage,
  inputImageBytes,
  inputImageChunkBytes,
  inputImageTotalBytes,
  readInputFileChunk,
} from './input-image-encoding';
import {
  inputImageCount,
  inputImageWindowCount,
  type NativeAttachmentRecovery,
  type NativePendingAttachment,
  type NativePendingAttachmentWrite,
} from './input-images-bridge';
import type { NativeBridge } from './native-bridge';
import { NativeImagePreviews } from './native-image-previews';
import type { OutputDraftFile } from './output-files-bridge';

type ImageDraft = {
  id: string;
  name: string;
  url: string;
  generation: number;
  size: number;
  abort: AbortController;
  loading?: boolean;
  error?: string;
  errorKind?: 'system';
  previewError?: string;
  previewFrame?: 'first' | 'static';
  previewSource?: ImagePreviewSource;
};
const mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type FileDraft = {
  id: string;
  name: string;
  uri: string;
  generation: number;
  prepared?: boolean;
  error?: string;
  output?: OutputDraftFile;
};
type SavedScope = {
  sessionId: string;
  workspaceId?: string;
  revision: number;
  signature: string;
  known: Set<string>;
  consumed: Set<string>;
  recovered?: Set<string>;
  recoveryPending?: Set<string>;
  recoveryErrors?: Map<string, string>;
  recoveryRemoved?: Set<string>;
  ready: boolean;
  changed: boolean;
  moving?: boolean;
  migrationUnknown?: boolean;
  migrationSnapshot?: string;
  error?: string;
  queue: Promise<void>;
};
const attachmentSaveError = '附件草稿尚未确认保存，请重新打开会话核对后再发送。';

function attachmentHostOutdated(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'invalid_native_request' || code === 'native_host_operation_unavailable';
}

/** Draft bytes belong to their original conversation, independent of the currently read page. */
export function useNativeInputImages(
  bridge: NativeBridge | undefined,
  generation: number | undefined,
  storeId: string | undefined,
  localFileReferences = false,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: Derived content cannot cross a connection, generation or Store boundary.
  const previews = useMemo(() => new NativeImagePreviews(), [bridge, generation, storeId]);
  // A quit waiter belongs to this exact renderer connection, not a later mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Every connection boundary retires its waiters.
  const preparationOwner = useMemo(() => new AbortController(), [bridge, generation, storeId]);
  const drafts = useRef(new Map<string, (ImageDraft | FileDraft)[]>());
  // Retain original Files under the existing draft budgets, never original URLs.
  // Stale UI callbacks only hold the item, not the removed File's bytes.
  const originals = useRef(new Map<ImageDraft, { file: Blob; mediaType: string; blob?: Blob }>());
  const preparation = useRef(Promise.resolve());
  const preparationFailures = useRef(0);
  const savedScopes = useRef(new Map<string, SavedScope>());
  const preparingFiles = useRef(new Set<AbortController>());
  const pendingFileHandoffs = useRef(
    new Map<AbortController, { promise: Promise<void>; finish: (error?: unknown) => void }>(),
  );
  const pendingMoves = useRef(new Set<Promise<void>>());
  const preparedFiles = useRef(new Set<string>());
  const fileHandoffs = useRef(new Map<string, () => void>());
  const [, redraw] = useReducer((value) => value + 1, 0);
  const current = useRef({ bridge, generation, storeId });
  useLayoutEffect(() => {
    current.current = { bridge, generation, storeId };
  });
  useEffect(() => {
    return () => {
      preparationOwner.abort();
      preparation.current = Promise.resolve();
      pendingMoves.current.clear();
      previews.clear();
      for (const controller of preparingFiles.current) controller.abort();
      preparingFiles.current.clear();
      for (const handoff of pendingFileHandoffs.current.values()) handoff.finish();
      pendingFileHandoffs.current.clear();
      if (bridge && generation)
        for (const id of preparedFiles.current)
          void bridge.request({ method: 'input.files.release', generation, id }).catch(() => {});
      preparedFiles.current.clear();
      for (const images of drafts.current.values())
        for (const image of images) {
          if (!('url' in image)) continue;
          image.abort.abort();
          if (image.url) URL.revokeObjectURL(image.url);
          if (bridge && generation && storeId)
            void bridge
              .request({ method: 'input.images.release', generation, id: image.id })
              .catch(() => {});
        }
      originals.current.clear();
      drafts.current.clear();
      savedScopes.current.clear();
    };
  }, [bridge, generation, storeId, previews, preparationOwner]);
  function all(key: string) {
    return drafts.current.get(key)?.filter((image) => image.generation === generation) ?? [];
  }
  function active() {
    return (
      !!bridge &&
      !!generation &&
      !!storeId &&
      !preparationOwner.signal.aborted &&
      current.current.bridge === bridge &&
      current.current.generation === generation &&
      current.current.storeId === storeId
    );
  }
  function document(key: string): NativePendingAttachmentWrite[] {
    return all(key)
      .filter((item) => !('output' in item && item.output))
      .map((item) => {
        if ('url' in item)
          return {
            id: item.id,
            kind: 'image' as const,
            name: item.name,
            ...(item.error ? { state: 'error' as const, error: item.error, size: 0 } : {}),
          };
        return item.prepared
          ? {
              id: item.id,
              kind: 'file' as const,
              name: item.name,
              ...(item.error ? { state: 'error' as const, error: item.error, size: 0 } : {}),
            }
          : { id: item.id, kind: 'reference' as const, name: item.name, uri: item.uri };
      });
  }
  function normalized(entries: readonly NativePendingAttachmentWrite[]) {
    return JSON.stringify(
      entries.map((item) =>
        item.kind === 'reference'
          ? { id: item.id, kind: item.kind, name: item.name, uri: item.uri }
          : {
              id: item.id,
              kind: item.kind,
              name: item.name,
              ...(item.state === 'error'
                ? { state: 'error', error: '附件已失效，请移除后重新添加。', size: 0 }
                : {}),
            },
      ),
    );
  }
  function remember(scope: SavedScope, signature: string) {
    scope.known.add(signature);
    while (scope.known.size > 16) scope.known.delete(scope.known.values().next().value!);
  }
  function reconcile(key: string, scope: SavedScope, acceptedIds: readonly string[] = []) {
    const allowed = new Set(scope.known);
    allowed.add(scope.signature);
    const ids = new Set(acceptedIds);
    for (const signature of [...allowed]) {
      try {
        allowed.add(
          JSON.stringify(JSON.parse(signature).filter((item: { id: string }) => !ids.has(item.id))),
        );
      } catch {
        /* No verified snapshot yet. */
      }
    }
    const task = async () => {
      if (!active() || savedScopes.current.get(key) !== scope) return;
      try {
        const value = await bridge!.request({
          method: 'input.attachments.read',
          generation: generation!,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
        });
        if (!active() || savedScopes.current.get(key) !== scope) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'input.attachments' ||
          !('attachments' in value)
        )
          throw Error('attachment_restore_unconfirmed');
        const signature = normalized(value.attachments);
        // Read-back may confirm our last write or exact receipt removal, never overwrite another window's edits.
        if (
          !allowed.has(signature) &&
          signature !== normalized(document(key)) &&
          !scope.known.has(signature)
        )
          throw Error('attachment_revision_conflict');
        scope.revision = value.revision;
        scope.signature = signature;
        remember(scope, signature);
        scope.error = undefined;
        scope.ready = true;
        persist(key);
      } catch {
        if (active() && savedScopes.current.get(key) === scope) scope.error = attachmentSaveError;
      }
      if (active()) redraw();
    };
    scope.queue = scope.queue.then(task, task);
    return scope.queue;
  }
  function persist(key: string) {
    const scope = savedScopes.current.get(key);
    if (!scope || !active()) return;
    scope.changed = true;
    const task = async () => {
      if (
        !active() ||
        savedScopes.current.get(key) !== scope ||
        !scope.ready ||
        scope.error ||
        scope.moving
      )
        return;
      // A partially transferred image must never replace a durable attachment set.
      if (get(key).some((item) => item.loading)) return;
      const attachments = document(key),
        signature = normalized(attachments);
      const expectedRevision = scope.revision;
      if (signature === scope.signature) {
        scope.changed = false;
        return;
      }
      remember(scope, signature);
      try {
        const value = await bridge!.request({
          method: 'input.attachments.write',
          generation: generation!,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
          revision: expectedRevision,
          attachments,
        });
        if (!active() || savedScopes.current.get(key) !== scope) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'input.attachments' ||
          !('revision' in value) ||
          value.revision !== expectedRevision + 1
        )
          throw Error('attachment_save_unconfirmed');
        scope.revision = value.revision;
        scope.signature = signature;
        scope.changed = normalized(document(key)) !== signature;
      } catch {
        if (active() && savedScopes.current.get(key) === scope) scope.error = attachmentSaveError;
      }
      if (active()) redraw();
    };
    scope.queue = scope.queue.then(task, task);
  }
  async function restoredImage(
    key: string,
    scope: SavedScope,
    item: ImageDraft,
    saved: NativePendingAttachment,
  ) {
    if (saved.kind !== 'image' || saved.state !== 'ready') return;
    const alive = () =>
      active() &&
      savedScopes.current.get(key) === scope &&
      !item.abort.signal.aborted &&
      drafts.current.get(key)?.includes(item);
    const source: ImagePreviewSource = {
      load: async (signal) => {
        signal.throwIfAborted();
        if (!alive()) throw Error('input_image_draft_inactive');
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        for (let offset = 0; offset < saved.size!; ) {
          const chunk = await bridge!.request({
            method: 'input.attachments.preview',
            generation: generation!,
            sessionId: scope.sessionId,
            workspaceId: scope.workspaceId,
            id: saved.id,
            offset,
          });
          signal.throwIfAborted();
          if (!alive()) throw Error('input_image_draft_inactive');
          if (
            !chunk ||
            !('kind' in chunk) ||
            chunk.kind !== 'input.image.chunk' ||
            !('offset' in chunk) ||
            chunk.offset !== offset ||
            chunk.nextOffset <= offset ||
            chunk.nextOffset > saved.size!
          )
            throw Error('attachment_image_unavailable');
          const data = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
          if (data.length !== chunk.nextOffset - offset)
            throw Error('attachment_image_unavailable');
          chunks.push(data);
          offset = chunk.nextOffset;
        }
        const blob = new Blob(chunks, { type: saved.mediaType });
        if (saved.hash && (await hashInputImage(blob, signal)) !== saved.hash)
          throw Error('attachment_image_hash_mismatch');
        return blob;
      },
    };
    item.previewSource = source;
    try {
      const blob = await source.load!(item.abort.signal);
      if (!alive()) return;
      originals.current.set(item, { file: blob, blob, mediaType: saved.mediaType! });
      item.previewSource = originalSource(key, item);
      const preview = await previews.prepare(blob, saved.hash!, item.abort.signal);
      if (alive()) {
        item.url = URL.createObjectURL(preview.blob);
        item.previewFrame = preview.frame;
      }
    } catch {
      if (alive()) item.previewError = '预览不可用';
    }
    if (alive()) redraw();
  }
  function restore(key: string, sessionId: string, workspaceId?: string): Promise<void> {
    if (!active()) return Promise.resolve();
    const prior = savedScopes.current.get(key);
    if (prior) {
      if (!prior.error || prior.migrationUnknown) return prior.queue;
      if (prior.ready) return reconcile(key, prior);
      savedScopes.current.delete(key);
    }
    const scope: SavedScope = {
      sessionId,
      workspaceId,
      revision: 0,
      signature: '',
      known: new Set(),
      consumed: new Set(),
      ready: false,
      changed: false,
      queue: Promise.resolve(),
    };
    savedScopes.current.set(key, scope);
    scope.queue = (async () => {
      try {
        const value = await bridge!.request({
          method: 'input.attachments.read',
          generation: generation!,
          sessionId,
          workspaceId,
        });
        if (!active() || savedScopes.current.get(key) !== scope) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'input.attachments' ||
          !('attachments' in value)
        )
          throw Error('attachment_restore_unconfirmed');
        scope.revision = value.revision;
        const currentItems = all(key),
          currentIds = new Set(currentItems.map((item) => item.id));
        const restored: (ImageDraft | FileDraft)[] = [];
        for (const saved of value.attachments) {
          if (currentIds.has(saved.id)) continue;
          const error = saved.state === 'error' ? '附件已失效，请移除后重新添加。' : undefined;
          if (saved.kind === 'image') {
            const item: ImageDraft = {
              id: saved.id,
              name: saved.name,
              size: saved.size ?? 0,
              generation: generation!,
              url: '',
              abort: new AbortController(),
              error,
            };
            restored.push(item);
          } else {
            const prepared = saved.kind === 'file';
            if (prepared && !error) preparedFiles.current.add(saved.id);
            restored.push({
              id: saved.id,
              name: saved.name,
              generation: generation!,
              prepared,
              error,
              uri:
                saved.kind === 'reference'
                  ? saved.uri!
                  : `file:///kite-prepared/${saved.id}/${encodeURIComponent(saved.name)}`,
            });
          }
        }
        drafts.current.set(key, [...restored, ...currentItems]);
        scope.ready = true;
        scope.signature = normalized(document(key));
        remember(scope, scope.signature);
        redraw();
        for (const saved of value.attachments) {
          const item = get(key).find((image) => image.id === saved.id);
          if (item && !item.error) void restoredImage(key, scope, item, saved);
        }
        if (scope.changed || currentItems.length) {
          scope.signature = '';
          persist(key);
        }
      } catch (cause) {
        if (active() && savedScopes.current.get(key) === scope) {
          const code = (cause as { code?: string })?.code ?? (cause as Error)?.message;
          scope.error = [
            'native_image_budget_unavailable',
            'native_file_budget_unavailable',
          ].includes(code)
            ? '当前窗口附件容量已满，请移除其他会话的附件后重新打开本会话。'
            : '待发送附件未能恢复，请重新打开会话核对，避免遗漏附件。';
          redraw();
        }
      }
    })();
    redraw();
    return scope.queue;
  }
  async function flush(key: string): Promise<number | undefined> {
    const scope = savedScopes.current.get(key);
    if (!scope) return;
    persist(key);
    for (;;) {
      const pending = scope.queue;
      await pending;
      if (pending === scope.queue) break;
    }
    if (
      !active() ||
      savedScopes.current.get(key) !== scope ||
      !scope.ready ||
      scope.error ||
      scope.recoveryErrors?.size ||
      get(key).some((item) => item.loading || item.error) ||
      files(key).some((item) => item.error)
    )
      throw Error('attachment_draft_unavailable');
    return document(key).length ? scope.revision : undefined;
  }
  /** Normal quit confirms durable drafts, not whether every retained item is sendable. */
  async function flushForQuit(): Promise<void> {
    if (!active()) {
      if (
        (!bridge || !generation || !storeId) &&
        !drafts.current.size &&
        !preparingFiles.current.size
      )
        return;
      throw Error('attachment_draft_inactive');
    }
    const signal = preparationOwner.signal;
    const failures = preparationFailures.current;
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject;
    });
    const cancel = () => rejectCancelled(Error('attachment_draft_inactive'));
    signal.addEventListener('abort', cancel, { once: true });
    const wait = (tasks: readonly Promise<unknown>[]) =>
      Promise.race([Promise.all(tasks), cancelled]);
    const assertActive = () => {
      if (!active() || signal.aborted) throw Error('attachment_draft_inactive');
    };
    try {
      for (;;) {
        assertActive();
        const preparing = preparation.current;
        await wait([
          preparing,
          ...[...pendingFileHandoffs.current.values()].map((handoff) => handoff.promise),
          ...pendingMoves.current,
        ]);
        assertActive();
        if (
          preparation.current !== preparing ||
          pendingFileHandoffs.current.size ||
          pendingMoves.current.size
        )
          continue;
        const scopes = [...savedScopes.current];
        for (const key of drafts.current.keys())
          if (!savedScopes.current.has(key) && document(key).length)
            throw Error('attachment_draft_unavailable');
        const queues = new Map<string, Promise<void>>();
        for (const [key, scope] of scopes) {
          // A lost atomic move preserves the frozen batch in its source or target.
          // With no later edits, cold restore is the existing recovery path.
          if (scope.migrationUnknown) {
            if (normalized(document(key)) !== scope.migrationSnapshot)
              throw Error('attachment_draft_unavailable');
            queues.set(key, scope.queue);
            continue;
          }
          // A retry can read back our known snapshots, never rebase over another window.
          if (scope.ready && scope.error) await wait([reconcile(key, scope)]);
          persist(key);
          for (;;) {
            const pending = scope.queue;
            await wait([pending]);
            assertActive();
            if (savedScopes.current.get(key) !== scope) throw Error('attachment_draft_inactive');
            if (pending === scope.queue) break;
          }
          // A failed read with no local attachments has changed nothing on disk.
          // It must not make an untouched, already durable scope impossible to close.
          if (!scope.ready && !document(key).length) {
            queues.set(key, scope.queue);
            continue;
          }
          if (
            !scope.ready ||
            scope.error ||
            scope.moving ||
            scope.changed ||
            get(key).some((item) => item.loading) ||
            normalized(document(key)) !== scope.signature
          )
            throw Error('attachment_draft_unavailable');
          queues.set(key, scope.queue);
        }
        assertActive();
        if (preparationFailures.current !== failures) throw Error('attachment_preparation_failed');
        if (
          preparation.current !== preparing ||
          pendingFileHandoffs.current.size ||
          pendingMoves.current.size ||
          scopes.length !== savedScopes.current.size ||
          scopes.some(
            ([key, scope]) =>
              savedScopes.current.get(key) !== scope || scope.queue !== queues.get(key),
          )
        )
          continue;
        return;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  function blocked(key: string) {
    const scope = savedScopes.current.get(key);
    return (
      !!scope &&
      (!scope.ready ||
        !!scope.error ||
        !!scope.moving ||
        !!scope.recoveryErrors?.size ||
        !!scope.recoveryPending?.size)
    );
  }
  function error(key: string) {
    const scope = savedScopes.current.get(key);
    return scope?.recoveryErrors?.values().next().value ?? scope?.error;
  }
  function recovery(key: string, commandId: string, result: NativeAttachmentRecovery) {
    const scope = savedScopes.current.get(key);
    if (!scope || !active() || scope.migrationUnknown || scope.recovered?.has(commandId)) return;
    if (
      result.sessionId !== scope.sessionId ||
      (scope.workspaceId && result.workspaceId !== scope.workspaceId)
    )
      return;
    const unavailable = '原附件尚未恢复，请重新恢复附件后再发送。';
    if (result.phase === 'unavailable') {
      scope.recoveryErrors ??= new Map();
      if (scope.recoveryErrors.get(commandId) !== unavailable) {
        scope.recoveryErrors.set(commandId, unavailable);
        redraw();
      }
      return;
    }
    if (result.phase === 'not_needed') {
      if (scope.recoveryErrors?.delete(commandId)) redraw();
      return;
    }
    if (result.revision === undefined || !result.ids || scope.recoveryPending?.has(commandId))
      return;
    scope.recoveryPending ??= new Set();
    scope.recoveryPending.add(commandId);
    const task = async () => {
      const removed = new Set<string>();
      if (!active() || savedScopes.current.get(key) !== scope) return;
      scope.recoveryRemoved = removed;
      try {
        const value = await bridge!.request({
          method: 'input.attachments.read',
          generation: generation!,
          sessionId: scope.sessionId,
          workspaceId: scope.workspaceId,
        });
        if (!active() || savedScopes.current.get(key) !== scope) return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'input.attachments' ||
          !('attachments' in value) ||
          value.revision < result.revision!
        )
          throw Error('attachment_restore_unconfirmed');
        const ids = new Set(result.ids);
        if (
          value.revision === result.revision &&
          [...ids].some((id) => !value.attachments.some((item) => item.id === id))
        )
          throw Error('attachment_restore_unconfirmed');
        const consumed = new Set<string>();
        for (const receipt of scope.consumed) {
          for (const id of JSON.parse(receipt)[1] as string[]) consumed.add(id);
        }
        const base = (signature: string) =>
          JSON.stringify(
            JSON.parse(signature).filter(
              (item: { id: string }) => !ids.has(item.id) && !consumed.has(item.id),
            ),
          );
        const allowed = new Set(
          [...scope.known, scope.signature, normalized(document(key))].filter(Boolean).map(base),
        );
        // Only this proven recovery may add unknown identities. Other-window changes
        // remain a conflict, never an excuse to replace the current draft.
        if (!allowed.has(base(normalized(value.attachments))))
          throw Error('attachment_revision_conflict');
        const currentItems = all(key);
        const currentIds = new Set(currentItems.map((item) => item.id));
        const additions: (ImageDraft | FileDraft)[] = [];
        for (const saved of value.attachments) {
          if (!ids.has(saved.id) || currentIds.has(saved.id) || removed.has(saved.id)) continue;
          const itemError = saved.state === 'error' ? '附件已失效，请移除后重新添加。' : undefined;
          if (saved.kind === 'image')
            additions.push({
              id: saved.id,
              name: saved.name,
              size: saved.size ?? 0,
              generation: generation!,
              url: '',
              abort: new AbortController(),
              error: itemError,
            });
          else {
            const prepared = saved.kind === 'file';
            if (prepared && !itemError) preparedFiles.current.add(saved.id);
            additions.push({
              id: saved.id,
              name: saved.name,
              generation: generation!,
              prepared,
              error: itemError,
              uri:
                saved.kind === 'reference'
                  ? saved.uri!
                  : `file:///kite-prepared/${saved.id}/${encodeURIComponent(saved.name)}`,
            });
          }
        }
        drafts.current.set(key, [...currentItems, ...additions]);
        scope.revision = value.revision;
        scope.signature = normalized(value.attachments);
        remember(scope, scope.signature);
        scope.ready = true;
        scope.error = undefined;
        scope.recoveryErrors?.delete(commandId);
        scope.recovered ??= new Set();
        scope.recovered.add(commandId);
        while (scope.recovered.size > 256)
          scope.recovered.delete(scope.recovered.values().next().value!);
        // The Main binding has at most 256 retained commands; old receipts cannot
        // authorize a replay or resurrection after a successful merge.
        for (const saved of value.attachments) {
          const item = additions.find(
            (entry): entry is ImageDraft => entry.id === saved.id && 'url' in entry,
          );
          if (item && !item.error) void restoredImage(key, scope, item, saved);
        }
        persist(key);
      } catch {
        if (active() && savedScopes.current.get(key) === scope) {
          scope.recoveryErrors ??= new Map();
          scope.recoveryErrors.set(commandId, unavailable);
        }
      } finally {
        if (scope.recoveryRemoved === removed) scope.recoveryRemoved = undefined;
        scope.recoveryPending?.delete(commandId);
        if (active()) redraw();
      }
    };
    scope.queue = scope.queue.then(task, task);
    redraw();
  }
  function accepted(key: string, revision: number | undefined, ids: readonly string[]) {
    // A retired callback cannot mark a new owner's receipt consumed before its
    // read-back, or prevent the current owner from reconciling the same receipt.
    if (!active()) return;
    const scope = savedScopes.current.get(key);
    if (!scope || revision === undefined) {
      removeIds(ids);
      return;
    }
    const receipt = JSON.stringify([revision, ids]);
    if (scope.consumed.has(receipt)) return;
    scope.consumed.add(receipt);
    while (scope.consumed.size > 128) scope.consumed.delete(scope.consumed.values().next().value!);
    removeIds(ids, false);
    void reconcile(key, scope, ids);
  }
  function originalSource(key: string, item: ImageDraft): ImagePreviewSource {
    return {
      load: async (signal) => {
        signal.throwIfAborted();
        const original = originals.current.get(item);
        if (
          !original ||
          item.abort.signal.aborted ||
          current.current.bridge !== bridge ||
          current.current.generation !== item.generation ||
          current.current.storeId !== storeId ||
          !drafts.current.get(key)?.includes(item)
        )
          throw Error('input_image_draft_inactive');
        original.blob ??= original.file.slice(0, original.file.size, original.mediaType);
        return original.blob;
      },
    };
  }
  function get(key: string) {
    return all(key).filter((item): item is ImageDraft => 'url' in item);
  }
  function files(key: string) {
    return all(key).filter((item): item is FileDraft => 'uri' in item);
  }
  function addFiles(
    key: string,
    selected: readonly {
      name: string;
      uri: string;
      id?: string;
      prepared?: boolean;
      output?: OutputDraftFile;
    }[],
  ) {
    if (
      !bridge ||
      !generation ||
      !storeId ||
      current.current.bridge !== bridge ||
      current.current.generation !== generation ||
      current.current.storeId !== storeId
    )
      return;
    const uris = new Map(files(key).map((file) => [file.uri, file.id]));
    drafts.current.set(key, [
      ...all(key),
      ...selected
        .filter((file) => {
          if (uris.has(file.uri)) {
            if (file.id) fileHandoffs.current.get(file.id)?.();
            if (file.prepared && file.id && file.id !== uris.get(file.uri)) {
              preparedFiles.current.delete(file.id);
              void bridge
                .request({ method: 'input.files.release', generation, id: file.id })
                .catch(() => {});
            }
            return false;
          }
          uris.set(file.uri, file.id ?? '');
          return true;
        })
        .map((file) => {
          if (file.id) fileHandoffs.current.get(file.id)?.();
          return { ...file, id: file.id ?? crypto.randomUUID(), generation };
        }),
    ]);
    persist(key);
    redraw();
  }
  function removeIds(ids: readonly string[], save = true) {
    const selected = new Set(ids);
    for (const [key, images] of drafts.current) {
      if (save) for (const id of selected) savedScopes.current.get(key)?.recoveryRemoved?.add(id);
      const releases: (() => void)[] = [];
      for (const image of images.filter((image) => selected.has(image.id))) {
        if (!('url' in image)) {
          preparedFiles.current.delete(image.id);
          if (image.prepared && bridge && generation)
            releases.push(() => {
              void bridge
                .request({ method: 'input.files.release', generation, id: image.id })
                .catch(() => {});
            });
          continue;
        }
        image.abort.abort();
        originals.current.delete(image);
        image.previewSource = undefined;
        if (image.url) URL.revokeObjectURL(image.url);
        if (bridge && generation)
          releases.push(() => {
            void bridge
              .request({ method: 'input.images.release', generation, id: image.id })
              .catch(() => {});
          });
      }
      drafts.current.set(
        key,
        images.filter((image) => !selected.has(image.id)),
      );
      if (save && images.some((image) => selected.has(image.id))) persist(key);
      const pending = savedScopes.current.get(key)?.queue;
      if (pending)
        void pending.then(() => {
          for (const release of releases) release();
        });
      else for (const release of releases) release();
    }
    redraw();
  }
  function move(from: string, to: string) {
    const task = moveDraft(from, to);
    pendingMoves.current.add(task);
    void task.then(
      () => pendingMoves.current.delete(task),
      () => pendingMoves.current.delete(task),
    );
    return task;
  }
  async function moveDraft(from: string, to: string) {
    if (from === to || !drafts.current.has(from)) return;
    const source = savedScopes.current.get(from);
    let target = savedScopes.current.get(to);
    let moved = all(from);
    let transferredIds = new Set(moved.map((item) => item.id));
    let targetSignature: string | undefined;
    if (source) {
      let moveDispatched = false;
      try {
        await flush(from);
        const identity: unknown = JSON.parse(to);
        if (!Array.isArray(identity) || identity[0] !== storeId || typeof identity[1] !== 'string')
          throw Error('attachment_scope_unavailable');
        await restore(to, identity[1]);
        target = savedScopes.current.get(to);
        if (!target) throw Error('attachment_scope_unavailable');
        await flush(to);
        if (!active() || savedScopes.current.get(from) !== source) return;
        moved = all(from);
        transferredIds = new Set(moved.map((item) => item.id));
        source.moving = target.moving = true;
        source.migrationSnapshot = normalized(document(from));
        target.migrationSnapshot = normalized(document(to));
        redraw();
        moveDispatched = true;
        const value = await bridge!.request({
          method: 'input.attachments.move',
          generation: generation!,
          sessionId: target.sessionId,
          workspaceId: source.workspaceId!,
          revision: source.revision,
          targetRevision: target.revision,
        });
        if (
          !active() ||
          savedScopes.current.get(from) !== source ||
          savedScopes.current.get(to) !== target
        )
          return;
        if (
          !value ||
          !('kind' in value) ||
          value.kind !== 'input.attachments' ||
          !('sourceRevision' in value) ||
          typeof value.sourceRevision !== 'number'
        )
          throw Error('attachment_move_unconfirmed');
        source.revision = value.sourceRevision;
        source.signature = '[]';
        remember(source, '[]');
        target.revision = value.revision;
        targetSignature = normalized(value.attachments);
        const retained = new Set(value.attachments.map((item) => item.id));
        moved = moved.filter((item) => retained.has(item.id));
      } catch {
        if (active()) {
          source.migrationUnknown = moveDispatched;
          source.error = '附件转入会话尚未确认，请完全退出并重新打开应用核对。';
          if (target) {
            target.error = source.error;
            target.migrationUnknown = moveDispatched;
          }
          redraw();
        }
        return;
      } finally {
        source.moving = false;
        if (target) target.moving = false;
      }
    }
    // UI removals made while Main committed the move are newer than its frozen source batch.
    const remaining = new Set(all(from));
    const removedIds = new Set(moved.filter((item) => !remaining.has(item)).map((item) => item.id));
    moved = moved.filter((item) => remaining.has(item));
    const movedIds = new Set(moved.map((item) => item.id));
    for (const item of moved)
      if ('url' in item && originals.current.has(item))
        item.previewSource = originalSource(to, item);
    drafts.current.set(to, [
      ...all(to).filter((item) => !movedIds.has(item.id) && !removedIds.has(item.id)),
      ...moved,
    ]);
    drafts.current.set(
      from,
      all(from).filter((item) => !transferredIds.has(item.id)),
    );
    if (target) {
      target.signature = targetSignature ?? normalized(document(to));
      remember(target, target.signature);
    }
    persist(from);
    persist(to);
    redraw();
  }
  function validateAttachments(
    key: string,
    selected: readonly File[],
    ordinary: readonly { name: string; uri?: string }[] = [],
  ) {
    const reject = (code: string, message: string): never => {
      throw Object.assign(Error(code), { code, validationMessage: message });
    };
    const existing = new Set(files(key).map((file) => file.uri));
    const added = new Set(
      ordinary
        .filter((file) => !file.uri || !existing.has(file.uri))
        .map((file, index) => file.uri ?? `selected:${index}`),
    );
    if (existing.size + added.size > 128)
      reject('input_file_count_limit', '文件附件最多 128 个，请移除部分后重试。');
    if (get(key).length + selected.length > inputImageCount)
      throw Object.assign(Error('input_image_count_limit'), { code: 'input_image_count_limit' });
    if (
      [...drafts.current.keys()].reduce((count, scope) => count + get(scope).length, 0) +
        selected.length >
      inputImageWindowCount
    )
      throw Object.assign(Error('input_image_window_count_limit'), {
        code: 'input_image_window_count_limit',
      });
    let total = [...drafts.current.values()]
      .flat()
      .filter((item): item is ImageDraft => 'url' in item)
      .reduce((sum, item) => sum + item.size, 0);
    for (const file of selected) {
      const mediaType = imageMediaType(file);
      if (!mediaTypes.includes(mediaType as (typeof mediaTypes)[number]))
        reject('input_image_type', '图片支持 PNG、JPEG、WebP、GIF，请转换格式后重试。');
      if (!file.size || file.size > inputImageBytes)
        reject('input_image_too_large', '图片为空或超过 16 MiB，请缩小后重试。');
      total += file.size;
    }
    if (total > inputImageTotalBytes)
      reject('input_image_total_limit', '待发送图片总量超过 64 MiB，请移除部分图片后重试。');
  }
  function imageMediaType(file: File) {
    return (
      file.type ||
      (
        {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
        } as Record<string, string>
      )[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ||
      ''
    );
  }
  async function add(key: string, files: readonly File[]): Promise<{ error: string } | undefined> {
    if (!bridge || !generation || !storeId) return;
    validateAttachments(key, files);
    const original = { bridge, generation, storeId };
    const pending: Promise<void>[] = [];
    const failures = new Map<ImageDraft, string>();
    for (const file of files) {
      if (
        current.current.bridge !== bridge ||
        current.current.generation !== generation ||
        current.current.storeId !== storeId
      )
        return;
      const id = crypto.randomUUID();
      const mediaType = imageMediaType(file);
      const item: ImageDraft = {
        id,
        name: file.name || '粘贴的图片',
        generation,
        size: 0,
        abort: new AbortController(),
        url: '',
        loading: true,
      };
      drafts.current.set(key, [...all(key), item]);
      item.size = file.size;
      originals.current.set(item, { file, mediaType });
      item.previewSource = originalSource(key, item);
      const alive = () =>
        !item.abort.signal.aborted &&
        current.current.bridge === original.bridge &&
        current.current.generation === generation &&
        current.current.storeId === storeId &&
        get(key).includes(item);
      const prepare = async () => {
        if (!alive()) return;
        try {
          const hash = await hashInputImage(file, item.abort.signal);
          if (!alive()) return;
          try {
            const preview = await previews.prepare(
              file.slice(0, file.size, mediaType),
              hash,
              item.abort.signal,
            );
            if (!alive()) return;
            item.url = URL.createObjectURL(preview.blob);
            item.previewFrame = preview.frame;
          } catch {
            if (!alive()) return;
            // Preview failure does not change or prevent the original image submission.
            item.previewError = '预览不可用';
            failures.set(item, '图片预览不可用，仍可发送原图。');
          }
          redraw();
          await bridge.request({
            method: 'input.images.begin',
            generation,
            id,
            name: item.name,
            mediaType: mediaType as (typeof mediaTypes)[number],
            size: file.size,
            hash,
          });
          for (let offset = 0; offset < file.size; offset += inputImageChunkBytes) {
            if (!alive()) throw Error('changed');
            const data = await encodeInputImageChunk(
              file.slice(offset, offset + inputImageChunkBytes),
              item.abort.signal,
            );
            if (!alive()) throw Error('changed');
            await bridge.request({ method: 'input.images.append', generation, id, offset, data });
          }
          if (!alive()) throw Error('changed');
          await bridge.request({ method: 'input.images.finish', generation, id });
          item.loading = false;
        } catch (error) {
          void bridge.request({ method: 'input.images.release', generation, id }).catch(() => {});
          if (!alive()) return;
          preparationFailures.current++;
          item.loading = false;
          if (item.url) URL.revokeObjectURL(item.url);
          item.url = '';
          item.size = 0;
          originals.current.delete(item);
          item.previewSource = undefined;
          item.errorKind = 'system';
          item.error = attachmentHostOutdated(error)
            ? '图片附件功能尚未加载，请完全退出并重新打开应用。'
            : '图片准备失败，请移除后重新添加。';
          failures.set(item, item.error);
        }
        if (alive()) {
          persist(key);
          redraw();
        }
      };
      const task = preparation.current.then(prepare);
      preparation.current = task.catch(() => {});
      pending.push(task);
    }
    redraw();
    await Promise.all(pending);
    if (
      current.current.bridge === original.bridge &&
      current.current.generation === generation &&
      current.current.storeId === storeId
    ) {
      const messages = [
        ...new Set(
          [...failures]
            .filter(([item]) => !item.abort.signal.aborted && get(key).includes(item))
            .map(([, message]) => message),
        ),
      ];
      if (messages.length) return { error: messages.join('\n') };
    }
    return undefined;
  }
  async function fileReferences(selected: readonly File[], signal?: AbortSignal) {
    if (!bridge?.fileReferences)
      throw Object.assign(Error('file_picker_restart_required'), {
        code: 'file_picker_restart_required',
      });
    if (!generation || !storeId) throw Error('file_reference_unavailable');
    const references = bridge.fileReferences(selected);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    preparingFiles.current.add(controller);
    let finishHandoff!: (error?: unknown) => void;
    const handedOff = new Promise<void>((resolve, reject) => {
      finishHandoff = (error) => (error === undefined ? resolve() : reject(error));
    });
    // Rejections are observed by an active quit waiter and by fileReferences' caller.
    void handedOff.catch(() => {});
    pendingFileHandoffs.current.set(controller, { promise: handedOff, finish: finishHandoff });
    const ids: string[] = [];
    const unclaimed = new Set<string>();
    let ready = false;
    const cleanup = (error?: unknown) => {
      signal?.removeEventListener('abort', abort);
      preparingFiles.current.delete(controller);
      pendingFileHandoffs.current.delete(controller);
      finishHandoff(error);
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        if (!ready) return;
        for (const id of unclaimed) {
          fileHandoffs.current.delete(id);
          preparedFiles.current.delete(id);
          if (ids.includes(id))
            void bridge.request({ method: 'input.files.release', generation, id }).catch(() => {});
        }
        unclaimed.clear();
        cleanup();
      },
      { once: true },
    );
    const prepare = async () => {
      const result: { name: string; uri: string; id: string; prepared?: boolean }[] = [];
      const check = () => {
        controller.signal.throwIfAborted();
        if (
          current.current.bridge !== bridge ||
          current.current.generation !== generation ||
          current.current.storeId !== storeId
        )
          throw Error('file_preparation_cancelled');
      };
      try {
        for (const [index, file] of selected.entries()) {
          check();
          const id = crypto.randomUUID();
          const reference = references[index];
          if (localFileReferences && reference?.uri.startsWith('file://')) {
            result.push({ ...reference, id });
            continue;
          }
          if (file.size > 256 * 1024 * 1024) throw Error('input_file_too_large');
          ids.push(id);
          preparedFiles.current.add(id);
          await bridge.request({
            method: 'input.files.begin',
            generation,
            id,
            name: file.name,
            mediaType:
              file.type ||
              (file.name.toLowerCase().endsWith('.pdf')
                ? 'application/pdf'
                : 'application/octet-stream'),
            size: file.size,
          });
          for (let offset = 0; offset < file.size; offset += 65536) {
            check();
            const data = await readInputFileChunk(
              file.slice(offset, offset + 65536),
              controller.signal,
            );
            await bridge.request({ method: 'input.files.append', generation, id, offset, data });
          }
          check();
          await bridge.request({ method: 'input.files.finish', generation, id });
          check();
          result.push({
            name: reference?.name || file.name,
            uri: reference?.uri || `file:///kite-prepared/${id}/${encodeURIComponent(file.name)}`,
            id,
            prepared: true,
          });
        }
        check();
        ready = true;
        for (const { id } of result) {
          unclaimed.add(id);
          fileHandoffs.current.set(id, () => {
            fileHandoffs.current.delete(id);
            unclaimed.delete(id);
            if (!unclaimed.size) cleanup();
          });
        }
        if (!unclaimed.size) cleanup();
        return result;
      } catch (error) {
        for (const id of ids) preparedFiles.current.delete(id);
        await Promise.allSettled(
          ids.map((id) => bridge.request({ method: 'input.files.release', generation, id })),
        );
        if (!controller.signal.aborted) preparationFailures.current++;
        cleanup(controller.signal.aborted ? undefined : error);
        throw error;
      } finally {
        if (!ready) cleanup();
      }
    };
    const task = preparation.current.then(prepare);
    preparation.current = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  return {
    get,
    files,
    add,
    addFiles,
    removeIds,
    move,
    fileReferences,
    validateAttachments,
    previews,
    restore,
    flush,
    flushForQuit,
    blocked,
    error,
    accepted,
    recovery,
    recoveryFailed: (key: string) => [
      ...(savedScopes.current.get(key)?.recoveryErrors?.keys() ?? []),
    ],
  };
}
