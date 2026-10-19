export const inputImageBytes = 16 * 1024 * 1024;
export const inputImageTotalBytes = inputImageBytes * 4;
export const inputImageChunkBytes = 32768;

/** Native asynchronous reads avoid building one JS string/array entry per image byte. */
function read(blob: Blob, mode: 'buffer' | 'base64', signal: AbortSignal) {
  return new Promise<ArrayBuffer | string>((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      finish(new DOMException('Image preparation cancelled', 'AbortError'));
    };
    function finish(error?: unknown, result?: ArrayBuffer | string) {
      signal.removeEventListener('abort', abort);
      reader.onload = reader.onerror = reader.onabort = null;
      if (error) reject(error);
      else resolve(result!);
    }
    reader.onload = () => {
      if (reader.result === null) finish(Error('image_read_failed'));
      else finish(undefined, reader.result);
    };
    reader.onerror = () => finish(Error('image_read_failed'));
    reader.onabort = () => finish(new DOMException('Image preparation cancelled', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (mode === 'buffer') reader.readAsArrayBuffer(blob);
      else reader.readAsDataURL(blob);
    } catch (error) {
      finish(error);
    }
  });
}

export async function hashInputImage(file: File, signal: AbortSignal): Promise<string> {
  const buffer = (await read(file, 'buffer', signal)) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  signal.throwIfAborted();
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function encodeInputImageChunk(blob: Blob, signal: AbortSignal): Promise<string> {
  if (blob.size > inputImageChunkBytes) throw Error('image_chunk_too_large');
  const dataURL = (await read(blob, 'base64', signal)) as string;
  const prefix = dataURL.indexOf(';base64,');
  if (prefix < 0) throw Error('image_encoding_failed');
  return dataURL.slice(prefix + 8);
}
