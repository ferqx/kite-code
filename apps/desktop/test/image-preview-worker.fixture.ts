import type { ImagePreviewWorker } from '../src/native-image-previews';

/** JSDOM does not decode images. Browser fixtures exercise the actual native worker. */
export function installImagePreviewWorker() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class PreviewWorker {
    onmessage: ImagePreviewWorker['onmessage'] = null;
    onerror: ImagePreviewWorker['onerror'] = null;
    private closed = false;
    postMessage({ id }: { id: number; source: Blob }) {
      queueMicrotask(() => {
        if (this.closed) return;
        this.onmessage?.call(
          this as unknown as Worker,
          {
            data: { id, blob: new Blob(['derived'], { type: 'image/webp' }), width: 1, height: 1 },
          } as MessageEvent,
        );
      });
    }
    terminate() {
      this.closed = true;
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: PreviewWorker,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else Reflect.deleteProperty(globalThis, 'Worker');
  };
}
