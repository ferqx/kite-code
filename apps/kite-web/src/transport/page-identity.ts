import { WebRestTransportError } from './client';

/** Bind every REST response to the instance/build that served this document. */
export function createPageBoundFetch(
  expectedIdentity: string | undefined,
  onChanged: () => void,
  request: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const response = await request(input, init);
    if (!expectedIdentity || response.headers.get('x-kite-web-identity') !== expectedIdentity) {
      onChanged();
      throw new WebRestTransportError('protocol_error', response.status);
    }
    return response;
  };
}
