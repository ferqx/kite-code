/** Presentation-only bridge. No paths, URLs, file handles or application requests. */
export const nativeImageGalleryPresentChannel = 'kite:native:image-gallery-present';
export const nativeImageGalleryCloseChannel = 'kite:native:image-gallery-close';
export const nativeImageGalleryActionChannel = 'kite:native:image-gallery-action';
export const nativeImageGalleryEventChannel = 'kite:native:image-gallery-event';
export const nativeImageGalleryStateChannel = 'kite:native:image-gallery-state';
export const nativeImageGalleryActiveChannel = 'kite:native:image-gallery-active';
export const nativeImageGalleryLimit = 16 * 1024 * 1024;
export type NativeImageGalleryItem = { id: string; name: string };
export type NativeImageGalleryImage =
  | { status: 'loading' | 'error' }
  | {
      status: 'ready';
      /** Opaque identity of one admitted Root Blob; never a source locator. */
      revision: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      bytes: Uint8Array;
    };
export type NativeImageGalleryPresentation = {
  sessionId: string;
  items: NativeImageGalleryItem[];
  selectedId: string;
  language: 'zh' | 'en';
  image: NativeImageGalleryImage;
};
export type NativeImageGalleryState =
  | (NativeImageGalleryPresentation & { theme: 'light' | 'dark' })
  | null;
export type NativeImageGalleryAction = { sessionId: string } & (
  | { type: 'select'; id: string }
  | { type: 'retry' | 'close' }
  | { type: 'unavailable' }
);
export interface NativeImageGalleryBridge {
  present(state: NativeImageGalleryPresentation): void;
  close(sessionId: string): void;
  watchActions(listener: (action: NativeImageGalleryAction) => void): () => void;
}
/** Only this port is exposed in the isolated image renderer. */
export interface NativeImageGalleryViewerBridge {
  watch(listener: (state: NativeImageGalleryState) => void): () => void;
  ready(): void;
  act(action: Exclude<NativeImageGalleryAction, { type: 'unavailable' }>): void;
}
export const nativeImageGalleryId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
export const nativeImageGallerySessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function record(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Reflect.ownKeys(input).every(
    (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(input, key)!,
  );
}
export function isNativeImageGalleryAction(input: unknown): input is NativeImageGalleryAction {
  if (!record(input) || !nativeImageGallerySessionId(input.sessionId)) return false;
  return input.type === 'select'
    ? Object.keys(input).sort().join(',') === 'id,sessionId,type' && nativeImageGalleryId(input.id)
    : Object.keys(input).sort().join(',') === 'sessionId,type' &&
        (input.type === 'retry' || input.type === 'close' || input.type === 'unavailable');
}
export function isNativeImageGalleryPresentation(
  input: unknown,
  themed = false,
): input is NativeImageGalleryPresentation {
  if (
    !record(input) ||
    Object.keys(input).sort().join(',') !==
      (themed
        ? 'image,items,language,selectedId,sessionId,theme'
        : 'image,items,language,selectedId,sessionId') ||
    !nativeImageGallerySessionId(input.sessionId) ||
    !nativeImageGalleryId(input.selectedId) ||
    (input.language !== 'zh' && input.language !== 'en') ||
    (themed && input.theme !== 'light' && input.theme !== 'dark') ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 64
  )
    return false;
  const ids = new Set<string>();
  for (const item of input.items) {
    if (
      !record(item) ||
      Object.keys(item).sort().join(',') !== 'id,name' ||
      !nativeImageGalleryId(item.id) ||
      typeof item.name !== 'string' ||
      item.name.length > 512 ||
      ids.has(item.id)
    )
      return false;
    ids.add(item.id);
  }
  if (!ids.has(input.selectedId) || !record(input.image)) return false;
  const image = input.image;
  if (image.status === 'loading' || image.status === 'error')
    return Object.keys(image).join(',') === 'status';
  return (
    Object.keys(image).sort().join(',') === 'bytes,mimeType,revision,status' &&
    image.status === 'ready' &&
    nativeImageGallerySessionId(image.revision) &&
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType as string) &&
    ArrayBuffer.isView(image.bytes) &&
    Object.prototype.toString.call(image.bytes) === '[object Uint8Array]' &&
    (image.bytes as Uint8Array).byteLength > 0 &&
    (image.bytes as Uint8Array).byteLength <= nativeImageGalleryLimit
  );
}
declare global {
  interface Window {
    kiteNativeImageGallery?: NativeImageGalleryBridge;
    kiteImageGalleryViewer?: NativeImageGalleryViewerBridge;
  }
}
