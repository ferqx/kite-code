/** Observe host layout only; callers retain ownership checks and IPC ordering. */
export function observeNativeContent(
  node: HTMLElement,
  publish: () => void,
  schedule: () => void,
  trackPosition?: () => boolean,
) {
  const doc = node.ownerDocument;
  let frame: number | undefined;
  const tick = () => {
    frame = undefined;
    publish();
    if (trackPosition?.()) frame = window.requestAnimationFrame(tick);
  };
  const changed = () => {
    if (frame !== undefined) return;
    if (trackPosition?.()) frame = window.requestAnimationFrame(tick);
    else schedule();
  };
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
  resize?.observe(node);
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement)
    resize?.observe(ancestor);
  const mutations = new MutationObserver(changed);
  mutations.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'style',
      'class',
      'data-native-browser-layout',
      'data-animate-width',
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
  window.addEventListener('scroll', changed, true);
  doc.addEventListener('visibilitychange', publish);
  if (trackPosition?.()) frame = window.requestAnimationFrame(tick);
  return () => {
    resize?.disconnect();
    mutations.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', publish);
    window.removeEventListener('scroll', changed, true);
    doc.removeEventListener('visibilitychange', publish);
  };
}
