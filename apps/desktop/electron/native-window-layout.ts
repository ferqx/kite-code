type LayoutWindow = { isDestroyed(): boolean };
type LayoutBatch = { tasks: Set<() => void>; pending: ReturnType<typeof setImmediate> };
const batches = new WeakMap<LayoutWindow, LayoutBatch>();

/** Leave the enclosing native resize callback before updating sibling surfaces. */
export function queueNativeWindowLayout(window: LayoutWindow, task: () => void): void {
  const current = batches.get(window);
  if (current) {
    current.tasks.add(task);
    return;
  }
  if (window.isDestroyed()) return;
  const tasks = new Set([task]);
  const batch: LayoutBatch = {
    tasks,
    pending: setImmediate(() => {
      if (batches.get(window) !== batch) return;
      batches.delete(window);
      for (const run of tasks) {
        if (window.isDestroyed()) break;
        run();
      }
    }),
  };
  batches.set(window, batch);
}

export function cancelNativeWindowLayout(window: LayoutWindow, task: () => void): void {
  const batch = batches.get(window);
  if (!batch) return;
  batch.tasks.delete(task);
  if (batch.tasks.size) return;
  clearImmediate(batch.pending);
  batches.delete(window);
}
