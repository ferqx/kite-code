import type { NativeBridge } from './native-bridge';
import { clippedViewport, measuredLayout, visibleElement } from './native-content-measurement';
import { observeNativeContent } from './native-content-observer';

/** Geometry lifetime only. The caller owns file readiness, identity and authorization. */
export function presentNativePreview(
  node: HTMLElement,
  bridge: NativeBridge,
  generation: number,
  previewId: string,
  onIssue?: (message: string) => void,
  onInterrupted?: () => void,
) {
  let stopped = false,
    ready = false,
    revision = 0,
    last = '',
    hidden = true;
  let inFlight: object | undefined;
  let dirty = false;
  let rejected = '';
  let paintFailed = false;
  const moving = () =>
    !!node.closest(
      '[data-slot="resizable-panel-group"]:is([data-animate-width="true"], :has(> [data-separator="active"]))',
    );
  const report = (cause: unknown) => {
    const code =
      cause instanceof Error
        ? cause.message
        : cause && typeof cause === 'object' && 'code' in cause
          ? cause.code
          : '';
    if (code === 'preview_paint_failed') {
      if (!paintFailed) onIssue?.('预览绘制失败，请关闭后重新打开。');
      paintFailed = true;
    } else if (!['preview_layout_stale', 'preview_replaced'].includes(String(code))) {
      onIssue?.('预览显示尚未确认，请重新打开文件。');
    }
  };
  const measure = () => {
    if (!ready || !node.isConnected || node.ownerDocument.hidden || !visibleElement(node))
      return { bounds: null };
    const bounds = clippedViewport(node);
    if (!bounds) return { bounds: null };
    const measured = measuredLayout(node, bounds);
    if (measured.kind === 'deferred') return;
    if (measured.kind === 'unsupported') return { bounds: null };
    return { bounds, ...(measured.kind === 'measured' ? { layout: measured.layout } : {}) };
  };
  const withdraw = () => {
    inFlight = undefined;
    dirty = false;
    last = '';
    if (hidden) return;
    hidden = true;
    try {
      bridge.presentPreviewLayout?.({
        generation,
        previewId,
        presentationRevision: ++revision,
        bounds: null,
      });
    } catch {
      // An already-retired owner cannot block observer disposal.
    }
  };
  const publish = (force = false) => {
    if (stopped || paintFailed) return;
    const measured = measure();
    if (!measured) return;
    if (!measured.bounds) {
      withdraw();
      return;
    }
    const key = JSON.stringify(measured);
    if (!force && (rejected === key || (!hidden && last === key))) return;
    if (hidden || force || moving()) {
      inFlight = undefined;
      dirty = false;
      const request = { generation, previewId, presentationRevision: ++revision, ...measured };
      try {
        if (!bridge.presentPreviewLayout) throw Error('preview_presentation_unavailable');
        bridge.presentPreviewLayout(request);
        hidden = false;
        rejected = '';
        onIssue?.('');
        last = key;
      } catch (cause) {
        rejected = key;
        last = key;
        report(cause);
      }
      return;
    }
    if (inFlight) {
      dirty = true;
      return;
    }
    const operation = {};
    inFlight = operation;
    last = key;
    const request = { generation, previewId, presentationRevision: ++revision, ...measured };
    void bridge
      .presentPreviewLayoutAsync?.(request)
      .catch((cause) => {
        if (stopped || inFlight !== operation) return;
        rejected = key;
        report(cause);
      })
      .finally(() => {
        if (inFlight !== operation) return;
        inFlight = undefined;
        if (dirty && !stopped) {
          dirty = false;
          publish();
        }
      });
  };
  let scheduled: number | undefined;
  const unobserve = observeNativeContent(
    node,
    () => publish(),
    () => {
      if (scheduled !== undefined) return;
      scheduled = window.requestAnimationFrame(() => {
        scheduled = undefined;
        publish();
      });
    },
    () => !stopped && !paintFailed && !node.ownerDocument.hidden && moving(),
  );
  const stop = () => {
    stopped = true;
    inFlight = undefined;
    if (scheduled !== undefined) window.cancelAnimationFrame(scheduled);
    unobserve();
    unwatch?.();
  };
  const unwatch = bridge.subscribePreviewPresentation?.((interrupted) => {
    if (stopped) return;
    if (!interrupted) publish(true);
    else if (interrupted.previewId === previewId && interrupted.generation === generation) {
      stop();
      onInterrupted?.();
    }
  });
  return {
    ready() {
      ready = true;
      publish(true);
    },
    dispose() {
      if (stopped) return;
      withdraw();
      stop();
    },
  };
}
