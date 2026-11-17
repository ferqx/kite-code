import type { NativeImageDisplayBridge } from '../src/native-image-display-bridge';

/** JSDOM cannot decode images. The codec suite exercises actual derived pixel bytes. */
export function installImagePreviewWorker() {
  const owner = window;
  const original = owner.kiteNativeImageDisplay;
  const bridge: NativeImageDisplayBridge = {
    render: async () => ({
      ok: true,
      value: {
        bytes: new TextEncoder().encode('derived'),
        mimeType: 'image/webp',
        width: 1,
        height: 1,
        sourceWidth: 1,
        sourceHeight: 1,
        animated: false,
        frame: 'static',
      },
    }),
    cancel() {},
  };
  owner.kiteNativeImageDisplay = bridge;
  // JSDOM's Blob lacks arrayBuffer, unlike Chromium. Preserve its actual source bytes.
  const prototype = owner.Blob.prototype;
  const arrayBuffer = Object.getOwnPropertyDescriptor(prototype, 'arrayBuffer');
  if (!arrayBuffer)
    Object.defineProperty(prototype, 'arrayBuffer', {
      configurable: true,
      value() {
        return new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new owner.FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(this);
        });
      },
    });
  return () => {
    owner.kiteNativeImageDisplay = original;
    if (!arrayBuffer) Reflect.deleteProperty(prototype, 'arrayBuffer');
  };
}
