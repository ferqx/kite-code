/** Give a retained page a rendering opportunity before admitting fresh view work. */
export function afterNativePresentation(view: Window): Promise<void> {
  if (view.document.hidden || typeof view.requestAnimationFrame !== 'function')
    return Promise.resolve();
  return new Promise((resolve) => {
    let frame: number | undefined;
    let task: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      if (task !== undefined) clearTimeout(task);
      clearTimeout(deadline);
      resolve();
    };
    // A window can become hidden after admission and stop delivering frames.
    const deadline = setTimeout(finish, 100);
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      // RAF precedes paint. Fresh IO starts in the following task, after this
      // rendering opportunity; actual painted latency is verified separately.
      task = setTimeout(finish, 0);
    });
  });
}
