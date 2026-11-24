import type { NativeBridge } from './native-bridge';
import type { OfficePreviewFrameClosed } from './native-preview-layout-bridge';
import { officePreviewWheelDelta, officePreviewWheelMessage } from './office-preview-zoom';

/** Mounts the Main-admitted URL inside the existing React viewport. */
export function createOfficePreviewFrame(
  host: HTMLElement,
  bridge: NativeBridge,
  generation: number,
  previewId: string,
  title: string,
  onUnavailable: (reason: NonNullable<OfficePreviewFrameClosed['reason']>) => void,
) {
  let element: HTMLIFrameElement | undefined;
  let stopWaiting: (() => void) | undefined;
  const document = host.ownerDocument;
  const onWheel = (event: WheelEvent) => {
    const frame = element;
    if (!frame || frame.inert) return;
    const delta = officePreviewWheelDelta(event, frame.clientHeight);
    if (!delta || document.elementFromPoint(event.clientX, event.clientY) !== frame) return;
    // Chromium can deliver a trackpad pinch over an opaque iframe to Root as Ctrl+wheel.
    event.preventDefault();
    frame.contentWindow?.postMessage({ kind: officePreviewWheelMessage, delta }, '*');
  };
  const detach = () => {
    document.removeEventListener('wheel', onWheel, true);
    element?.remove();
    element = undefined;
    stopWaiting?.();
  };
  const unwatch = bridge.subscribeOfficePreviewFrameClosed?.((event) => {
    if (event.previewId !== previewId || event.generation !== generation || !element) return;
    detach();
    if (event.reason) onUnavailable(event.reason);
  });
  return {
    async load(url: string) {
      if (!/^kite-office-preview:\/\/[a-f0-9-]{36}\/index\.html$/.test(url))
        throw Error('preview_frame_unavailable');
      const frame = host.ownerDocument.createElement('iframe');
      element = frame;
      frame.className = 'native-file-preview-iframe';
      frame.title = title;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.inert = true;
      frame.dataset.loading = 'true';
      try {
        await new Promise<void>((resolve, reject) => {
          const done = (error?: Error) => {
            clearTimeout(timer);
            frame.removeEventListener('load', loaded);
            stopWaiting = undefined;
            if (error) reject(error);
            else resolve();
          };
          const loaded = () => done();
          const timer = setTimeout(() => done(Error('preview_frame_unavailable')), 15000);
          stopWaiting = () => done(Error('preview_replaced'));
          frame.addEventListener('load', loaded, { once: true });
          frame.src = url;
          host.append(frame);
        });
        if (element !== frame) throw Error('preview_replaced');
        const result = await bridge.request({
          method: 'outputs.preview.frame.ready',
          previewId,
          generation,
        });
        if (element !== frame) throw Error('preview_replaced');
        if (
          !result ||
          !('kind' in result) ||
          result.kind !== 'outputs.preview' ||
          result.status !== 'ready'
        )
          throw Error('preview_frame_unavailable');
        frame.inert = false;
        delete frame.dataset.loading;
        document.addEventListener('wheel', onWheel, { capture: true, passive: false });
      } catch (error) {
        detach();
        void bridge
          .request({ method: 'outputs.preview.close', previewId, generation })
          .catch(() => {});
        throw error;
      }
    },
    dispose() {
      unwatch?.();
      detach();
    },
  };
}
