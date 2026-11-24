import {
  isNativeBrowserLayout,
  type NativeBrowserBounds,
  type NativeBrowserLayout,
} from './native-content-geometry';

export const nativePreviewLayoutChannel = 'kite:native:preview-layout';
export const nativePreviewPresentationChannel = 'kite:native:preview-presentation';
export const officePreviewFrameClosedChannel = 'kite:native:office-preview-frame-closed';
export type OfficePreviewFrameClosed = {
  previewId: string;
  generation: number;
  reason?: 'access' | 'interrupted';
};
/** Geometry only: never a file, session, network or interaction capability. */
export type NativePreviewLayoutRequest = {
  previewId: string;
  generation: number;
  presentationRevision: number;
  bounds: NativeBrowserBounds | null;
  layout?: NativeBrowserLayout;
};
export type NativePreviewLayoutIdentity = { previewId: string; generation: number };
export type NativePreviewLayoutReply =
  | { ok: true; value: NativePreviewLayoutIdentity }
  | { ok: false; code: string };
export function parseNativePreviewLayout(value: unknown): NativePreviewLayoutRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid_preview_layout');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !['previewId', 'generation', 'presentationRevision', 'bounds', 'layout'].includes(key),
    ) ||
    typeof input.previewId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.previewId) ||
    !Number.isSafeInteger(input.generation) ||
    (input.generation as number) < 0 ||
    !Number.isSafeInteger(input.presentationRevision) ||
    (input.presentationRevision as number) < 1
  )
    throw Error('invalid_preview_layout');
  if (input.bounds === null) {
    if (input.layout !== undefined) throw Error('invalid_preview_layout');
  } else {
    const bounds = input.bounds as Record<string, unknown> | undefined;
    if (
      !bounds ||
      typeof bounds !== 'object' ||
      Array.isArray(bounds) ||
      Object.keys(bounds).sort().join(',') !== 'height,radius,width,x,y' ||
      !Object.values(bounds).every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 32768,
      ) ||
      (bounds.radius as number) > 256 ||
      (input.layout !== undefined && !isNativeBrowserLayout(input.layout))
    )
      throw Error('invalid_preview_layout');
  }
  return input as NativePreviewLayoutRequest;
}

/** One strict acknowledgement boundary for sync and async preload transports. */
export function readNativePreviewLayoutReply(
  raw: unknown,
  request: Pick<NativePreviewLayoutRequest, 'previewId' | 'generation'>,
): NativePreviewLayoutIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw Error('invalid_preview_layout_reply');
  const reply = raw as Record<string, unknown>;
  if (
    reply.ok === false &&
    typeof reply.code === 'string' &&
    /^[a-z][a-z0-9_]{0,80}$/.test(reply.code) &&
    Object.keys(reply).sort().join(',') === 'code,ok'
  )
    throw Object.assign(Error(reply.code), { code: reply.code });
  if (
    reply.ok !== true ||
    Object.keys(reply).sort().join(',') !== 'ok,value' ||
    !reply.value ||
    typeof reply.value !== 'object' ||
    Array.isArray(reply.value)
  )
    throw Error('invalid_preview_layout_reply');
  const value = reply.value as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'generation,previewId' ||
    value.previewId !== request.previewId ||
    value.generation !== request.generation
  )
    throw Error('invalid_preview_layout_reply');
  return { previewId: request.previewId, generation: request.generation };
}
