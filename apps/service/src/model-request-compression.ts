import { constants, zstdCompress } from 'node:zlib';

/** Host-selected, exact official route only. No protocol fallback and no network retries. */
export function modelRequestCompression(
  binding: { provider: string; protocol: string; baseURL: string },
  transport: typeof fetch,
): typeof fetch {
  if (
    binding.provider !== 'openai' ||
    binding.protocol !== 'responses' ||
    !/^https:\/\/api\.openai\.com\/v1\/?$/.test(binding.baseURL)
  )
    return transport;
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (
        url !== 'https://api.openai.com/v1/responses' ||
        init?.method !== 'POST' ||
        typeof init.body !== 'string' ||
        Buffer.byteLength(init.body) < 256 * 1024
      )
        return transport(input, init);
      const headers = new Headers(init.headers);
      if (headers.has('content-encoding')) return transport(input, init);
      init.signal?.throwIfAborted();
      const body = await new Promise<Buffer>((resolve, reject) => {
        zstdCompress(
          Buffer.from(init.body as string),
          {
            params: { [constants.ZSTD_c_compressionLevel]: 3, [constants.ZSTD_c_windowLog]: 25 },
          },
          (error, result) => (error ? reject(error) : resolve(result)),
        );
      });
      init.signal?.throwIfAborted();
      // Small or high-entropy payloads keep identity. Compression never changes pixels.
      if (body.byteLength >= Buffer.byteLength(init.body)) return transport(input, init);
      headers.set('content-encoding', 'zstd');
      headers.delete('content-length');
      return transport(input, { ...init, headers, body: new Uint8Array(body) });
    },
    { preconnect: transport.preconnect },
  ) as typeof fetch;
}
