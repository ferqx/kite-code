/** Explicit background accounting tasks for DOM tests asserting an admitted hot entry. */
export function controlCacheAccounting(view: Pick<Window, 'setTimeout' | 'clearTimeout'>) {
  const schedule = view.setTimeout.bind(view);
  const cancel = view.clearTimeout.bind(view);
  const tasks = new Map<number, () => void>();
  let sequence = 0;
  view.setTimeout = ((task, delay, ...args) => {
    if (delay !== 0 || typeof task !== 'function') return schedule(task, delay, ...args);
    const id = --sequence;
    tasks.set(id, () => task(...args));
    return id;
  }) as typeof view.setTimeout;
  view.clearTimeout = (id) => {
    if (id !== undefined && tasks.delete(id)) return;
    cancel(id);
  };
  return {
    async flush() {
      await Promise.resolve();
      for (let count = 0; tasks.size; count++) {
        if (count >= 1000) throw Error('cache_accounting_did_not_settle');
        const [id, task] = tasks.entries().next().value!;
        tasks.delete(id);
        task();
        await Promise.resolve();
      }
    },
    restore() {
      tasks.clear();
      view.setTimeout = schedule;
      view.clearTimeout = cancel;
    },
  };
}
