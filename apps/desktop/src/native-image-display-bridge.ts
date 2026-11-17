/** Display-only limits. These do not alter attachment or model-tool contracts. */
export const nativeImageDisplaySourceByteLimit = 256 * 1024 * 1024;
export const nativeImageDisplayOutputByteLimit = 16 * 1024 * 1024;
export const nativeImageDisplayPixelLimit = 128_000_000;
export const nativeImageDisplayDimensionLimit = 65535;
export const nativeImageDisplayChannel = 'kite:image-display:render';
export const nativeImageDisplayCancelChannel = 'kite:image-display:cancel';
export type NativeImageDisplayMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export type NativeImageDisplayEdge = 512 | 1024 | 2048 | 4096;
/** Rectangle in EXIF-oriented original pixels, not derivative/display coordinates. */
export interface NativeImageDisplayRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeImageDisplayResult {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/webp';
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  animated: boolean;
  frame: 'first' | 'static';
  region?: NativeImageDisplayRegion;
}
export interface NativeImageDisplayRequest {
  id: string;
  bytes: Uint8Array;
  mediaType: NativeImageDisplayMediaType;
  edge: NativeImageDisplayEdge;
  region?: NativeImageDisplayRegion;
}
export type NativeImageDisplayReply =
  | { ok: true; value: NativeImageDisplayResult }
  | { ok: false; code: string };
export interface NativeImageDisplayBridge {
  render(request: NativeImageDisplayRequest): Promise<NativeImageDisplayReply>;
  cancel(id: string): void;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const isNativeImageDisplayId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export const isNativeImageDisplayMediaType = (
  value: unknown,
): value is NativeImageDisplayMediaType =>
  value === 'image/png' ||
  value === 'image/jpeg' ||
  value === 'image/webp' ||
  value === 'image/gif';
export const isNativeImageDisplayEdge = (value: unknown): value is NativeImageDisplayEdge =>
  value === 512 || value === 1024 || value === 2048 || value === 4096;
export function isNativeImageDisplayRegion(value: unknown): value is NativeImageDisplayRegion {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'height,left,top,width')
    return false;
  const coordinate = (v: unknown, minimum: number): v is number =>
    typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    v >= minimum &&
    v <= nativeImageDisplayDimensionLimit;
  return (
    coordinate(value.left, 0) &&
    coordinate(value.top, 0) &&
    coordinate(value.width, 1) &&
    coordinate(value.height, 1) &&
    value.left + value.width <= nativeImageDisplayDimensionLimit &&
    value.top + value.height <= nativeImageDisplayDimensionLimit &&
    value.width * value.height <= nativeImageDisplayPixelLimit
  );
}
export function nativeImageDisplayRegionFits(
  region: NativeImageDisplayRegion,
  width: number,
  height: number,
): boolean {
  return region.left + region.width <= width && region.top + region.height <= height;
}
export function isNativeImageDisplayRequest(value: unknown): value is NativeImageDisplayRequest {
  return (
    record(value) &&
    Object.keys(value).sort().join(',') ===
      ('region' in value ? 'bytes,edge,id,mediaType,region' : 'bytes,edge,id,mediaType') &&
    isNativeImageDisplayId(value.id) &&
    isNativeImageDisplayMediaType(value.mediaType) &&
    isNativeImageDisplayEdge(value.edge) &&
    (!('region' in value) || (isNativeImageDisplayRegion(value.region) && value.edge <= 2048)) &&
    ArrayBuffer.isView(value.bytes) &&
    Object.prototype.toString.call(value.bytes) === '[object Uint8Array]' &&
    value.bytes.byteLength > 0 &&
    value.bytes.byteLength <= nativeImageDisplaySourceByteLimit
  );
}
export function isNativeImageDisplayResult(value: unknown): value is NativeImageDisplayResult {
  if (
    !record(value) ||
    Object.keys(value).sort().join(',') !==
      ('region' in value
        ? 'animated,bytes,frame,height,mimeType,region,sourceHeight,sourceWidth,width'
        : 'animated,bytes,frame,height,mimeType,sourceHeight,sourceWidth,width')
  )
    return false;
  const dimension = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;
  return (
    ArrayBuffer.isView(value.bytes) &&
    Object.prototype.toString.call(value.bytes) === '[object Uint8Array]' &&
    value.bytes.byteLength > 0 &&
    value.bytes.byteLength <= nativeImageDisplayOutputByteLimit &&
    (value.mimeType === 'image/webp' || value.mimeType === 'image/png') &&
    dimension(value.width, 4096) &&
    dimension(value.height, 4096) &&
    dimension(value.sourceWidth, nativeImageDisplayDimensionLimit) &&
    dimension(value.sourceHeight, nativeImageDisplayDimensionLimit) &&
    value.sourceWidth * value.sourceHeight <= nativeImageDisplayPixelLimit &&
    value.width <= value.sourceWidth &&
    value.height <= value.sourceHeight &&
    (!('region' in value) ||
      (isNativeImageDisplayRegion(value.region) &&
        nativeImageDisplayRegionFits(value.region, value.sourceWidth, value.sourceHeight) &&
        value.width <= Math.min(2048, value.region.width) &&
        value.height <= Math.min(2048, value.region.height))) &&
    typeof value.animated === 'boolean' &&
    value.frame === (value.animated ? 'first' : 'static')
  );
}
/** Bind a child/IPC result to the exact requested crop, never another viewport. */
export function isNativeImageDisplayResultForRequest(
  value: unknown,
  request: { edge: NativeImageDisplayEdge; region?: NativeImageDisplayRegion },
): value is NativeImageDisplayResult {
  if (
    !isNativeImageDisplayResult(value) ||
    value.width > request.edge ||
    value.height > request.edge
  )
    return false;
  if (!request.region) return value.region === undefined;
  return (
    value.region !== undefined &&
    ['left', 'top', 'width', 'height'].every(
      (key) =>
        value.region![key as keyof NativeImageDisplayRegion] ===
        request.region![key as keyof NativeImageDisplayRegion],
    )
  );
}
export async function renderNativeImageDisplay(input: {
  bytes: Uint8Array;
  mediaType: NativeImageDisplayMediaType;
  edge: NativeImageDisplayEdge;
  signal?: AbortSignal;
  region?: NativeImageDisplayRegion;
}): Promise<NativeImageDisplayResult> {
  input.signal?.throwIfAborted();
  const bridge = typeof window === 'undefined' ? undefined : window.kiteNativeImageDisplay;
  if (!bridge) throw Error('native_image_display_unavailable');
  const id = crypto.randomUUID();
  const request = {
    id,
    bytes: input.bytes,
    mediaType: input.mediaType,
    edge: input.edge,
    ...(input.region === undefined ? {} : { region: { ...input.region } }),
  };
  if (!isNativeImageDisplayRequest(request)) throw Error('native_image_display_invalid');
  const abort = () => bridge.cancel(id);
  // Queue render before installing cancellation, so a same-turn abort cannot outrun it.
  const pending = bridge.render(request);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    const reply = await pending;
    input.signal?.throwIfAborted();
    if (!reply.ok) throw Error(reply.code);
    if (!isNativeImageDisplayResultForRequest(reply.value, request))
      throw Error('native_image_display_output_invalid');
    return reply.value;
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}
declare global {
  interface Window {
    kiteNativeImageDisplay?: NativeImageDisplayBridge;
  }
}
