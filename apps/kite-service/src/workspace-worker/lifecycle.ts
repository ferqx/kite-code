export type WorkspaceWorkerActivityKind = 'turn' | 'interaction' | 'effect' | 'client' | 'recovery';

export interface WorkspaceWorkerActivityLease extends AsyncDisposable {
  readonly kind: WorkspaceWorkerActivityKind;
  readonly activityId: string;
}

export interface WorkspaceWorkerIdleLifecycle {
  readonly state: 'starting' | 'ready' | 'idle_grace' | 'draining' | 'closed';
  readonly activeCount: number;
  markReady(): void;
  acquire(kind: WorkspaceWorkerActivityKind, activityId: string): WorkspaceWorkerActivityLease;
  /** Explicit stop remains busy while any authority/recovery hold is active. */
  stopIfIdle(): Promise<'closed' | 'busy'>;
  waitForClose(): Promise<void>;
}

export interface WorkspaceWorkerIdleLifecycleOptions {
  readonly idleGraceMs?: number;
  /** Flush snapshots, receipts, and effect evidence before the process exits. */
  readonly drain: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}

const DEFAULT_IDLE_GRACE_MS = 30_000;

/**
 * Worker lifecycle authority. Disconnecting one client only releases that
 * client hold; it never cancels a Turn, interaction, effect, or recovery hold.
 */
export function createWorkspaceWorkerIdleLifecycle(
  options: WorkspaceWorkerIdleLifecycleOptions,
): WorkspaceWorkerIdleLifecycle {
  const grace = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 300_000) {
    throw new RangeError('Workspace Worker idle grace is invalid.');
  }
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const activities = new Map<string, WorkspaceWorkerActivityLease>();
  let state: WorkspaceWorkerIdleLifecycle['state'] = 'starting';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveClosed = resolvePromise;
    rejectClosed = rejectPromise;
  });

  const armIdle = (): void => {
    if (state !== 'ready' || activities.size > 0 || timer !== undefined) return;
    state = 'idle_grace';
    timer = schedule(() => {
      timer = undefined;
      if (state !== 'idle_grace' || activities.size > 0) return;
      void closeWhenIdle();
    }, grace);
  };

  const cancelIdle = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    if (state === 'idle_grace') state = 'ready';
  };

  const closeWhenIdle = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    if (activities.size > 0) return Promise.reject(new Error('Workspace Worker is busy.'));
    cancelIdle();
    state = 'draining';
    closePromise = (async () => {
      let failure: unknown;
      try {
        await options.drain();
      } catch (error) {
        failure = error;
      }
      try {
        await options.close();
      } catch (error) {
        failure ??= error;
      }
      state = 'closed';
      if (failure !== undefined) {
        rejectClosed(failure);
        throw failure;
      }
      resolveClosed();
    })();
    return closePromise;
  };

  return Object.freeze({
    get state() {
      return state;
    },
    get activeCount() {
      return activities.size;
    },
    markReady() {
      if (state !== 'starting') throw new Error('Workspace Worker readiness already settled.');
      state = 'ready';
      armIdle();
    },
    acquire(kind: WorkspaceWorkerActivityKind, activityId: string) {
      if (!isActivityKind(kind) || !safeId(activityId)) {
        throw new TypeError('Workspace Worker activity identity is invalid.');
      }
      if (state === 'draining' || state === 'closed') {
        throw new Error('Workspace Worker is draining.');
      }
      const key = `${kind}\0${activityId}`;
      if (activities.has(key)) throw new Error('Workspace Worker activity is already held.');
      cancelIdle();
      let released = false;
      const lease: WorkspaceWorkerActivityLease = Object.freeze({
        kind,
        activityId,
        async [Symbol.asyncDispose]() {
          if (released) return;
          released = true;
          if (activities.get(key) !== lease) {
            throw new Error('Workspace Worker activity ownership changed.');
          }
          activities.delete(key);
          armIdle();
        },
      });
      activities.set(key, lease);
      return lease;
    },
    async stopIfIdle() {
      if (state === 'closed') return 'closed' as const;
      if (state === 'starting' || activities.size > 0 || state === 'draining') {
        return 'busy' as const;
      }
      await closeWhenIdle();
      return 'closed' as const;
    },
    waitForClose: () => closed,
  });
}

function isActivityKind(value: unknown): value is WorkspaceWorkerActivityKind {
  return (
    value === 'turn' ||
    value === 'interaction' ||
    value === 'effect' ||
    value === 'client' ||
    value === 'recovery'
  );
}

function safeId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value);
}
