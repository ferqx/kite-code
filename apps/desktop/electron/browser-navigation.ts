type NavigationReply = { frameId: string; loaderId?: string; errorText?: string };
type NavigationOperation = {
  url: string;
  epoch: number;
  ready: boolean;
  signal?: AbortSignal;
  current(): boolean;
  actualUrl(): string;
  /** Installed as the active owner before this single dispatch is invoked. */
  dispatch(): Promise<unknown>;
};

/** One Main-owned navigation. Document observations still use their stricter, separate gate. */
export function createBrowserNavigation() {
  type Pending = {
    input: NavigationOperation;
    epoch: number;
    committed?: number;
    ready?: number;
    inPage: boolean;
    reply?: NavigationReply;
    dispatching: boolean;
    failure?: { cause: unknown };
    finish(): void;
  };
  let disposed = false;
  let active: Pending | undefined;
  const fail = (cause = Error('browser_page_navigation_stale')) => {
    if (!active) return;
    active.failure ??= { cause };
    active.finish();
  };
  const check = () => {
    if (!active) return;
    if (disposed || !active.input.current()) fail();
    else active.finish();
  };
  return {
    start(epoch: number) {
      if (!active || epoch <= active.epoch) return;
      active.epoch = epoch;
      active.committed = undefined;
      active.ready = undefined;
      check();
    },
    commit(epoch: number) {
      if (!active || epoch !== active.epoch || epoch <= active.input.epoch) return;
      active.committed = epoch;
      check();
    },
    ready(epoch: number) {
      if (!active || epoch !== active.epoch) return;
      if (epoch !== active.input.epoch && active.committed !== epoch) return;
      active.ready = epoch;
      check();
    },
    inPage(epoch: number) {
      if (!active || epoch !== active.epoch) return;
      active.inPage = true;
      check();
    },
    stopped(epoch: number) {
      if (active && active.epoch === epoch && active.ready !== epoch)
        fail(Error('browser_page_navigation_not_ready'));
    },
    check,
    cancel: fail,
    dispose() {
      disposed = true;
      fail();
    },
    run(input: NavigationOperation): Promise<void> {
      input.signal?.throwIfAborted();
      if (disposed || !input.current())
        return Promise.reject(Error('browser_page_navigation_stale'));
      if (active) return Promise.reject(Error('browser_page_navigation_busy'));
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          pending.failure ??= { cause: input.signal?.reason };
          pending.finish();
        };
        const pending: Pending = {
          input,
          epoch: input.epoch,
          ...(input.ready ? { ready: input.epoch } : {}),
          inPage: false,
          dispatching: true,
          finish() {
            if (active !== pending || pending.dispatching) return;
            if (!input.current())
              pending.failure ??= { cause: Error('browser_page_navigation_stale') };
            const documentReady =
              pending.epoch > input.epoch &&
              pending.committed === pending.epoch &&
              pending.ready === pending.epoch;
            // A no-loader acknowledgement is Chromium's same-document/no-op
            // result. It does not need a second DOM-ready from the same document.
            let sameDocument = false;
            try {
              sameDocument =
                !pending.failure &&
                pending.reply !== undefined &&
                pending.reply.loaderId === undefined &&
                pending.epoch === input.epoch &&
                pending.ready === pending.epoch &&
                (pending.inPage || input.actualUrl() === input.url);
            } catch (cause) {
              pending.failure ??= { cause };
            }
            if (!pending.failure && (!pending.reply || (!documentReady && !sameDocument))) return;
            active = undefined;
            input.signal?.removeEventListener('abort', abort);
            if (pending.failure) reject(pending.failure.cause);
            else resolve();
          },
        };
        active = pending;
        input.signal?.addEventListener('abort', abort, { once: true });
        try {
          input.signal?.throwIfAborted();
          if (!input.current()) throw Error('browser_page_navigation_stale');
          // Keep the raw dispatch in flight even after cancellation. A late CDP
          // acknowledgement may settle its resources, but can never become success.
          Promise.resolve(input.dispatch()).then(
            (value) => {
              pending.dispatching = false;
              if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                typeof (value as NavigationReply).frameId !== 'string' ||
                !(value as NavigationReply).frameId ||
                (value as NavigationReply).errorText ||
                ((value as NavigationReply).loaderId !== undefined &&
                  (typeof (value as NavigationReply).loaderId !== 'string' ||
                    !(value as NavigationReply).loaderId))
              )
                pending.failure ??= { cause: Error('browser_page_navigation_failed') };
              else pending.reply = value as NavigationReply;
              pending.finish();
            },
            (cause) => {
              pending.dispatching = false;
              pending.failure ??= { cause };
              pending.finish();
            },
          );
        } catch (cause) {
          pending.dispatching = false;
          pending.failure ??= { cause };
          pending.finish();
        }
      });
    },
  };
}
