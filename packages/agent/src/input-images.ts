import { imageMediaTypes, type ModelImage } from '@kite-ai/ai';
import { AgentError, type InputImage } from './storage/types';

export function inputImages(value: unknown): InputImage[] {
  if (!Array.isArray(value)) throw new AgentError('input_image_invalid');
  let totalBytes = 0;
  for (const image of value) {
    const ref = image?.reference;
    if (
      !image ||
      Object.keys(image).sort().join(',') !== 'name,reference' ||
      typeof image.name !== 'string' ||
      !image.name ||
      image.name.length > 512 ||
      !ref ||
      Object.keys(ref).sort().join(',') !==
        'hash,id,mediaType,scope,sessionId,size,storeId,subjectId' ||
      typeof ref.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id) ||
      typeof ref.storeId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(ref.storeId) ||
      typeof ref.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(ref.sessionId) ||
      typeof ref.subjectId !== 'string' ||
      !ref.subjectId ||
      ref.subjectId.length > 256 ||
      !ref.scope ||
      Object.keys(ref.scope).sort().join(',') !== 'id,kind' ||
      ref.scope.kind !== 'session' ||
      ref.scope.id !== ref.sessionId ||
      typeof ref.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.hash) ||
      typeof ref.size !== 'string' ||
      ref.size.length > 8 ||
      !/^[1-9][0-9]*$/.test(ref.size) ||
      Number(ref.size) > 16 * 1024 * 1024 ||
      !imageMediaTypes.includes(ref.mediaType)
    )
      throw new AgentError('input_image_invalid');
    totalBytes += Number(ref.size);
    if (totalBytes > 64 * 1024 * 1024) throw new AgentError('input_image_invalid');
  }
  return value as InputImage[];
}

/** URLs are excluded: model assembly never fetches external content. */
export function decodeInputImage(data: string, mediaType: string): Uint8Array {
  if (
    !imageMediaTypes.includes(mediaType as ModelImage['mediaType']) ||
    typeof data !== 'string' ||
    !data ||
    data.length > Math.ceil((16 * 1024 * 1024) / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new AgentError('input_image_invalid');
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length > 16 * 1024 * 1024 ||
    bytes.toString('base64') !== data ||
    !matchesImageType(bytes, mediaType)
  )
    throw new AgentError('input_image_invalid');
  return bytes;
}

export function matchesImageType(bytes: Uint8Array, mediaType: string): boolean {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  return mediaType === 'image/png'
    ? bytes.length >= 24 &&
        bytes[0] === 137 &&
        text(1, 8) === 'PNG\r\n\x1a\n' &&
        text(12, 16) === 'IHDR'
    : mediaType === 'image/jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mediaType === 'image/gif'
        ? bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))
        : mediaType === 'image/webp'
          ? bytes.length >= 16 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP'
          : false;
}
