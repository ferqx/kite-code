import type {
  NativeExtensionHead,
  NativeExtensionScope,
  NativeExtensionsRequest,
} from './extensions-bridge';
import { readNativeBodyChunks } from './native-body-chunks';
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
    const bytes = await readNativeBodyChunks({
      byteLength: head.bodyBytes,
      readId: request.readId,
      kind: 'extensions.chunk',
      read: (offset, limit) =>
        bridge.request({
          method: 'extensions.read',
          generation: scope.generation,
          readId: request.readId,
          offset,
          limit,
        }),
      check,
      invalid: () => new Error('扩展内容分片无效'),
      incomplete: () => new Error('扩展内容不完整'),
    });
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
