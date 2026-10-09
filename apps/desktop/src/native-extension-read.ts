import type {
  NativeExtensionHead,
  NativeExtensionScope,
  NativeExtensionsRequest,
} from './extensions-bridge';
import type { NativeBridge } from './native-bridge';

/** One complete immutable body; closing its read retains the panel's observation. */
export async function readNativeExtensionBody<T>(
  bridge: NativeBridge,
  request: NativeExtensionsRequest & { readId: string },
  scope: NativeExtensionScope,
  content: 'catalogue' | 'views',
  isCurrent: () => boolean,
): Promise<{ head: NativeExtensionHead; value: T[] }> {
  const check = () => {
    if (!isCurrent()) throw new Error('扩展视图已改变');
  };
  try {
    check();
    const head = await bridge.request(request);
    check();
    if (
      !head ||
      !('scope' in head) ||
      !('kind' in head) ||
      head.kind !== 'extensions.head' ||
      head.readId !== request.readId ||
      head.content !== content ||
      !Number.isSafeInteger(head.observationId) ||
      head.observationId < 1 ||
      !Number.isSafeInteger(head.bodyBytes) ||
      head.bodyBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(head.sha256) ||
      Object.entries(scope).some(
        ([key, value]) => head.scope[key as keyof NativeExtensionScope] !== value,
      )
    )
      throw new Error('扩展完整内容身份不符');
    const bytes = new Uint8Array(head.bodyBytes);
    let offset = 0;
    for (;;) {
      check();
      const chunk = await bridge.request({
        method: 'extensions.read',
        generation: scope.generation,
        readId: request.readId,
        offset,
        limit: 65536,
      });
      check();
      if (
        !chunk ||
        !('offset' in chunk) ||
        chunk.kind !== 'extensions.chunk' ||
        chunk.readId !== request.readId ||
        chunk.offset !== offset ||
        typeof chunk.eof !== 'boolean' ||
        typeof chunk.data !== 'string' ||
        chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw new Error('扩展内容分片无效');
      const binary = atob(chunk.data),
        next = offset + binary.length;
      if (
        binary.length > 65536 ||
        chunk.nextOffset !== next ||
        next > bytes.length ||
        (!chunk.eof && !binary.length) ||
        chunk.eof !== (next === bytes.length)
      )
        throw new Error('扩展内容不完整');
      for (let index = 0; index < binary.length; index++)
        bytes[offset + index] = binary.charCodeAt(index);
      offset = next;
      if (chunk.eof) break;
    }
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    check();
    if (digest !== head.sha256) throw new Error('扩展内容校验失败');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(value)) throw new Error('扩展内容格式无效');
    return { head, value: value as T[] };
  } finally {
    await bridge
      .request({ method: 'extensions.close', generation: scope.generation, readId: request.readId })
      .catch(() => {});
  }
}
