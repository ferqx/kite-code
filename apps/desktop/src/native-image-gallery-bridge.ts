import {
  isNativeImageDisplayRegion,
  type NativeImageDisplayRegion,
  nativeImageDisplayRegionFits,
} from './native-image-display-bridge';
/** Presentation-only bridge. No paths, URLs, file handles or application requests. */
export const nativeImageGalleryPresentChannel = 'kite:native:image-gallery-present';
export const nativeImageGalleryCloseChannel = 'kite:native:image-gallery-close';
export const nativeImageGalleryActionChannel = 'kite:native:image-gallery-action';
export const nativeImageGalleryEventChannel = 'kite:native:image-gallery-event';
export const nativeImageGalleryStateChannel = 'kite:native:image-gallery-state';
export const nativeImageGalleryActiveChannel = 'kite:native:image-gallery-active';
export const nativeImageGalleryLimit = 16 * 1024 * 1024;
export type NativeImageGalleryDetail = {
  requestId: string;
  sourceKey: string;
  region: NativeImageDisplayRegion;
} & (
  | { status: 'loading' | 'error' }
  | {
      status: 'ready';
      bytes: Uint8Array;
      mimeType: 'image/webp' | 'image/png';
      width: number;
      height: number;
    }
);
export type NativeImageGalleryItem = { id: string; name: string };
export type NativeImageGalleryImage =
  | { status: 'loading' | 'error' }
  | {
      status: 'ready';
      /** Opaque identity of one admitted Root Blob; never a source locator. */
      revision: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      bytes: Uint8Array;
      detail?: NativeImageGalleryDetail;
      /** Derived display pixels; original identity and oriented dimensions preserve zoom. */
      display?: {
        key: string;
        sourceWidth: number;
        sourceHeight: number;
        edge: 1024 | 2048 | 4096;
        frame: 'first' | 'static';
      };
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
  | {
      type: 'detail';
      id: string;
      sourceKey: string;
      requestId: string;
      region: NativeImageDisplayRegion | null;
    }
  | { type: 'quality'; id: string; edge: 1024 | 2048 | 4096 }
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
  if (input.type === 'detail')
    return (
      Object.keys(input).sort().join(',') === 'id,region,requestId,sessionId,sourceKey,type' &&
      nativeImageGalleryId(input.id) &&
      nativeImageGallerySessionId(input.sourceKey) &&
      nativeImageGallerySessionId(input.requestId) &&
      (input.region === null || isNativeImageDisplayRegion(input.region))
    );
  if (input.type === 'quality')
    return (
      Object.keys(input).sort().join(',') === 'edge,id,sessionId,type' &&
      nativeImageGalleryId(input.id) &&
      [1024, 2048, 4096].includes(input.edge as number)
    );
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
  const display = image.display;
  if (
    display !== undefined &&
    (!record(display) ||
      Object.keys(display).sort().join(',') !== 'edge,frame,key,sourceHeight,sourceWidth' ||
      !nativeImageGallerySessionId(display.key) ||
      ![1024, 2048, 4096].includes(display.edge as number) ||
      !['first', 'static'].includes(display.frame as string) ||
      ![display.sourceWidth, display.sourceHeight].every(
        (value) =>
          Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 65535,
      ))
  )
    return false;
  const detail = image.detail;
  if (detail !== undefined) {
    if (
      !record(detail) ||
      !record(display) ||
      !nativeImageGallerySessionId(detail.requestId) ||
      detail.sourceKey !== display.key ||
      !isNativeImageDisplayRegion(detail.region) ||
      !nativeImageDisplayRegionFits(
        detail.region,
        display.sourceWidth as number,
        display.sourceHeight as number,
      )
    )
      return false;
    const fields = ['region', 'requestId', 'sourceKey', 'status'];
    if (detail.status === 'ready') {
      fields.push('bytes', 'mimeType', 'width', 'height');
      if (
        !ArrayBuffer.isView(detail.bytes) ||
        Object.prototype.toString.call(detail.bytes) !== '[object Uint8Array]' ||
        detail.bytes.byteLength < 1 ||
        detail.bytes.byteLength > nativeImageGalleryLimit ||
        !['image/png', 'image/webp'].includes(detail.mimeType as string) ||
        ![detail.width, detail.height].every(
          (v) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2048,
        )
      )
        return false;
    } else if (detail.status !== 'loading' && detail.status !== 'error') return false;
    if (Object.keys(detail).sort().join(',') !== fields.sort().join(',')) return false;
  }
  return (
    Object.keys(image).sort().join(',') ===
      [
        'bytes',
        'mimeType',
        'revision',
        'status',
        ...(display ? ['display'] : []),
        ...(detail ? ['detail'] : []),
      ]
        .sort()
        .join(',') &&
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

/** Choose the smallest bounded derivative that covers physical display pixels. */
export function nativeImageGalleryEdge(pixels: number): 1024 | 2048 | 4096 {
  return pixels <= 1024 ? 1024 : pixels <= 2048 ? 2048 : 4096;
}
