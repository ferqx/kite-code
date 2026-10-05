import type { AgentRuntime } from '@kite-ai/agent';

/** HTTP resource admission belongs to this transport, not to Store or Runtime work identity. */
export function createHttpLifecycle(
  runtime?: AgentRuntime,
  hostBeforeResourceClose?: () => Promise<void>,
) {
  let draining = false,
    sealed = false,
    failed = false,
    closed = false,
    resourceUsers = 0,
    mutationAdmissions = 0;
  let resolveIdle: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closeTask: Promise<void> | undefined;
  function state() {
    const core = runtime?.getLifecycleState();
    const reasons = new Set(core?.reasons ?? []);
    if (mutationAdmissions) reasons.add('admission');
    if (failed || (draining && !closed)) reasons.add('cleanup');
    return {
      state: failed
        ? ('drain_failed' as const)
        : closed
          ? ('closed' as const)
          : draining
            ? ('draining' as const)
            : (core?.state ?? ('accepting' as const)),
      busy: reasons.size !== 0,
      reasons: [...reasons],
    };
  }
  return {
    state,
    closedPromise,
    get draining() {
      return draining;
    },
    get sealed() {
      return sealed;
    },
    enter(mutation: boolean) {
      if (sealed) throw Error('service_draining');
      resourceUsers++;
      if (mutation) mutationAdmissions++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (mutation) mutationAdmissions--;
        resourceUsers--;
        if (!resourceUsers) resolveIdle?.();
      };
    },
    begin(mode: 'if_idle' | 'cancel', onSeal: () => void, onClosed: () => Promise<void>) {
      if (closeTask) return { accepted: true as const, completion: closeTask };
      if (mode === 'if_idle' && state().busy) return { accepted: false as const };
      const beforeResourceClose = async () => {
        sealed = true;
        await hostBeforeResourceClose?.();
        if (resourceUsers)
          await new Promise<void>((resolve) => {
            resolveIdle = resolve;
          });
      };
      const result = runtime?.tryBeginShutdown(mode, { beforeResourceClose });
      if (result && !result.accepted) return { accepted: false as const };
      draining = true;
      onSeal();
      closeTask = (async () => {
        try {
          if (result?.accepted) await result.completion;
          else await beforeResourceClose();
          closed = true;
          await onClosed();
          resolveClosed();
        } catch (error) {
          failed = true;
          throw error;
        }
      })();
      void closeTask.catch(() => {});
      return { accepted: true as const, completion: closeTask };
    },
  };
}
