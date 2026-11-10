import {
  createTrajectoryBundle,
  type LocalTrajectoryBundle,
  openTrajectoryBundle,
  type TrajectoryBundleDirectory,
} from '@kite-ai/client';
import {
  canonicalSerialize,
  parseDecimal64,
  type TrajectoryReadRequest,
  type TrajectoryScope,
  type TrajectorySnapshot,
  trajectorySnapshotSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import type { NativeBridge } from './native-bridge';

export interface NativeTrajectoryLocalCache extends TrajectoryBundleDirectory {
  write(path: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export interface NativeTrajectoryLoaded {
  source: LocalTrajectoryBundle;
  close(): Promise<void>;
}
const prefix = 'kite.trajectory-cache.v1.';
const cacheName = /^kite\.trajectory-cache\.v1\.[a-f0-9-]{36}$/;
const active = new Set<string>();
let cleanup: Promise<void> | undefined;
function cacheLocks(): LockManager {
  const locks = globalThis.navigator?.locks;
  if (!locks) throw Error('trajectory_cache_lock_unavailable');
  return locks;
}
async function holdCacheLock(name: string): Promise<() => void> {
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = cacheLocks().request(name, async () => {
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    acquired();
    await done;
  });
  await Promise.race([ready, held]);
  return release;
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('trajectory_cache_unavailable'));
  });
}
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(Error('trajectory_cache_unavailable'));
  });
}
async function deleteCache(factory: IDBFactory, name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(Error('trajectory_cache_cleanup_failed'));
    request.onblocked = () => reject(Error('trajectory_cache_cleanup_blocked'));
  });
}
/** Only this owner's named temporary databases with its exact marker are eligible for cleanup. */
export async function cleanupNativeTrajectoryCaches(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  if (typeof factory.databases !== 'function')
    throw Error('trajectory_cache_inventory_unavailable');
  for (const entry of await factory.databases()) {
    const name = entry.name;
    if (!name || !cacheName.test(name) || active.has(name)) continue;
    await cacheLocks().request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const request = factory.open(name);
      request.onupgradeneeded = () => request.transaction?.abort();
      const db = await requestValue(request);
      let owned = false;
      try {
        if (db.version === 1 && [...db.objectStoreNames].sort().join(',') === 'meta,sections') {
          const marker = await requestValue(
            db.transaction('meta').objectStore('meta').get('owner'),
          );
          owned =
            marker !== undefined &&
            canonicalSerialize(marker) ===
              canonicalSerialize({
                format: 'kite.trajectory-cache',
                version: 1,
                cacheId: name.slice(prefix.length),
              });
        }
      } finally {
        db.close();
      }
      if (owned) await deleteCache(factory, name);
    });
  }
}
/** Renderer-only temporary section storage. It holds no Evidence body, grants or business authority. */
export async function createNativeTrajectoryCache(): Promise<NativeTrajectoryLocalCache> {
  const factory = globalThis.indexedDB;
  if (!factory) throw Error('trajectory_cache_unavailable');
  cleanup ??= cleanupNativeTrajectoryCaches(factory).catch((cause) => {
    cleanup = undefined;
    throw cause;
  });
  await cleanup;
  const id = crypto.randomUUID();
  const name = `${prefix}${id}`;
  active.add(name);
  const releaseLock = await holdCacheLock(name);
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('sections');
    db.createObjectStore('meta').put(
      { format: 'kite.trajectory-cache', version: 1, cacheId: id },
      'owner',
    );
  };
  let db: IDBDatabase;
  try {
    db = await requestValue(request);
  } catch (cause) {
    active.delete(name);
    releaseLock();
    throw cause;
  }
  let closed = false;
  return {
    async write(path, bytes) {
      if (closed) throw Error('trajectory_cache_closed');
      const tx = db.transaction('sections', 'readwrite');
      const done = committed(tx);
      tx.objectStore('sections').put(Uint8Array.from(bytes), path);
      await done;
    },
    async list(signal) {
      signal?.throwIfAborted();
      if (closed) throw Error('trajectory_cache_closed');
      const keys = await requestValue(
        db.transaction('sections').objectStore('sections').getAllKeys(),
      );
      signal?.throwIfAborted();
      if (keys.some((key) => typeof key !== 'string')) throw Error('trajectory_cache_invalid');
      return keys as string[];
    },
    async read(path, signal, maximumBytes) {
      signal?.throwIfAborted();
      if (closed) throw Error('trajectory_cache_closed');
      const bytes = await requestValue(
        db.transaction('sections').objectStore('sections').get(path),
      );
      signal?.throwIfAborted();
      if (
        !(bytes instanceof Uint8Array) ||
        (maximumBytes !== undefined && bytes.byteLength > maximumBytes)
      )
        throw Error('trajectory_cache_invalid');
      return Uint8Array.from(bytes);
    },
    async close() {
      if (closed) return;
      closed = true;
      db.close();
      try {
        await deleteCache(factory, name);
      } finally {
        active.delete(name);
        releaseLock();
      }
    },
  };
}
export async function openNativeTrajectorySnapshot(
  bridge: NativeBridge,
  generation: number,
  scope: TrajectoryScope,
  signal?: AbortSignal,
): Promise<TrajectorySnapshot> {
  signal?.throwIfAborted();
  const value = await bridge.request({ method: 'trajectory.open', generation, request: scope });
  signal?.throwIfAborted();
  if (
    !value ||
    !('kind' in value) ||
    value.kind !== 'trajectory.snapshot' ||
    !('trajectory' in value)
  )
    throw Error('trajectory_snapshot_invalid');
  const snapshot = trajectorySnapshotSchema.parse(value.trajectory);
  if (
    snapshot.storeId !== scope.storeId ||
    snapshot.sessionId !== scope.sessionId ||
    snapshot.executionId !== scope.executionId ||
    snapshot.runId !== scope.runId ||
    canonicalSerialize(snapshot.eventKinds ?? []) !== canonicalSerialize(scope.eventKinds ?? [])
  )
    throw Error('trajectory_scope_mismatch');
  return snapshot;
}
/** Explicit online loading is complete before a player is handed the resulting local source. */
export async function loadNativeTrajectory(input: {
  bridge: NativeBridge;
  generation: number;
  snapshot: TrajectorySnapshot;
  cacheFactory?: () => Promise<NativeTrajectoryLocalCache>;
  previous?: LocalTrajectoryBundle;
  signal?: AbortSignal;
}): Promise<NativeTrajectoryLoaded> {
  const cache = await (input.cacheFactory ?? createNativeTrajectoryCache)();
  try {
    const remote = async (request: TrajectoryReadRequest, signal?: AbortSignal) => {
      const value = await input.bridge.request({
        method: 'trajectory.events',
        generation: input.generation,
        request,
      });
      signal?.throwIfAborted();
      if (
        !value ||
        !('kind' in value) ||
        value.kind !== 'trajectory.page' ||
        !('trajectory' in value)
      )
        throw Error('trajectory_page_invalid');
      return verifyTrajectoryPage(value.trajectory, request);
    };
    const readEvents = async (request: TrajectoryReadRequest, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const old = input.previous;
      if (
        old &&
        old.snapshot.storeId === request.storeId &&
        old.snapshot.sessionId === request.sessionId &&
        parseDecimal64(request.afterCursor) < parseDecimal64(old.snapshot.upperCursor) &&
        parseDecimal64(old.snapshot.upperCursor) <= parseDecimal64(request.upperCursor)
      ) {
        const prior = await old.readEvents(
          { ...request, upperCursor: old.snapshot.upperCursor },
          signal,
        );
        if (
          prior.exhausted &&
          parseDecimal64(old.snapshot.upperCursor) < parseDecimal64(request.upperCursor) &&
          prior.events.length < (request.limit ?? 200)
        ) {
          const tail = await remote(
            {
              ...request,
              afterCursor: old.snapshot.upperCursor,
              limit: (request.limit ?? 200) - prior.events.length,
            },
            signal,
          );
          return verifyTrajectoryPage(
            {
              ...tail,
              afterCursor: request.afterCursor,
              events: [...prior.events, ...tail.events],
            },
            request,
          );
        }
        return verifyTrajectoryPage(
          {
            ...prior,
            upperCursor: request.upperCursor,
            exhausted: prior.scannedThrough === request.upperCursor,
            integrity: input.snapshot.historyCoverage.integrity,
          },
          request,
        );
      }
      return remote(request, signal);
    };
    for await (const frame of createTrajectoryBundle({
      snapshot: input.snapshot,
      readEvents,
      signal: input.signal,
    })) {
      input.signal?.throwIfAborted();
      await cache.write(frame.path, frame.bytes);
    }
    const source = await openTrajectoryBundle(cache, {}, input.signal);
    return {
      source,
      close: async () => {
        source.clearCache();
        await cache.close();
      },
    };
  } catch (cause) {
    await cache.close();
    throw cause;
  }
}
