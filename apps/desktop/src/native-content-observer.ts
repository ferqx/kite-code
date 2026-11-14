/** Observe host layout only; callers retain ownership checks and IPC ordering. */
export function observeNativeContent(
  node: HTMLElement,
  publish: () => void,
  schedule: () => void,
  trackPosition = false,
) {
  const doc = node.ownerDocument;
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
  resize?.observe(node);
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement)
    resize?.observe(ancestor);
  const mutations = new MutationObserver(schedule);
  mutations.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'style',
      'class',
      'data-native-browser-layout',
      'data-state',
      'data-separator',
      'hidden',
    ],
  });
  mutations.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });
  window.addEventListener('resize', publish);
  window.addEventListener('scroll', schedule, true);
  doc.addEventListener('visibilitychange', publish);
  let stopped = false,
    frame: number | undefined;
  const tick = () => {
    if (stopped) return;
    publish();
    frame = window.requestAnimationFrame(tick);
  };
  if (trackPosition) frame = window.requestAnimationFrame(tick);
  return () => {
    stopped = true;
    resize?.disconnect();
    mutations.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', publish);
    window.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('visibilitychange', publish);
  };
}
