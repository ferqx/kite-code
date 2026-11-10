import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import type { TraceConsumerStore } from './consumer-store';
import type { TraceCredentialBroker } from './credentials';

export const traceHttpRequestSchema = z.strictObject({
  url: z.string().min(1).max(4096),
  method: z.enum(['GET', 'POST']),
  headers: z
    .strictObject({
      'content-type': z.string().max(256).optional(),
      accept: z.string().max(256).optional(),
      'idempotency-key': z.string().max(256).optional(),
    })
    .optional(),
  bodyBase64: z.string().max(87384).optional(),
  credentialHandle: z.string().uuid().optional(),
});
export type TraceHttpResult =
  | { status: 'complete'; httpStatus: number; bodyBase64: string }
  | {
      status: 'unavailable';
      code:
        | 'origin_denied'
        | 'target_denied'
        | 'credential_unavailable'
        | 'request_limit'
        | 'broker_busy'
        | 'permission_revoked'
        | 'invalid_request'
        | 'network_unavailable'
        | 'redirect_denied';
    }
  | { status: 'unconfirmed'; code: 'request_interrupted' | 'response_unavailable' };
interface NetworkContext {
  installationId: string;
  revision: string;
  epoch: string;
  generation: string;
  signal: AbortSignal;
}
function privateAddress(address: string): boolean {
  const lower = address.includes(':')
    ? new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
    : address;
  if (lower.includes(':')) {
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7);
      if (tail.includes('.')) return privateAddress(tail);
      const [first = 0, last = 0] = tail.split(':').map((part) => Number.parseInt(part, 16));
      return privateAddress(`${first >> 8}.${first & 255}.${last >> 8}.${last & 255}`);
    }
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff') ||
      lower.startsWith('2001:db8:') ||
      lower.startsWith('64:ff9b:') ||
      lower.startsWith('2002:') ||
      lower.startsWith('2001:0:')
    );
  }
  const [a = 0, b = 0] = lower.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
const localHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
/** A single approved DNS answer set yields the exact address used by the transport. */
export async function resolveTraceTarget(
  url: URL,
  allowPrivateNetwork: boolean,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const abort = () => reject(Error('request_timeout'));
        signal.addEventListener('abort', abort, { once: true });
        void lookup(hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
  signal.throwIfAborted();
  if (
    !records.length ||
    records.some(
      (record) =>
        !isIP(record.address) ||
        (privateAddress(record.address) &&
          !allowPrivateNetwork &&
          !(
            localHost(hostname) &&
            (record.address === '::1' || record.address.startsWith('127.'))
          )),
    )
  )
    throw Error('trace_target_denied');
  const target = records[0]!;
  if (target.family !== 4 && target.family !== 6) throw Error('trace_target_denied');
  return { address: target.address, family: target.family };
}
/** Direct pinned HTTP(S), with no fetch/proxy environment or unvalidated redirect path. */
export class TraceHttpBroker {
  private readonly store: TraceConsumerStore;
  private readonly credentials: TraceCredentialBroker | undefined;
  private readonly inFlight = new Map<string, number>();
  constructor(store: TraceConsumerStore, credentials?: TraceCredentialBroker) {
    this.store = store;
    this.credentials = credentials;
  }
  async request(inputValue: unknown, context: NetworkContext): Promise<TraceHttpResult> {
    const parsed = traceHttpRequestSchema.safeParse(inputValue);
    if (!parsed.success) return { status: 'unavailable', code: 'invalid_request' };
    if ((this.inFlight.get(context.installationId) ?? 0) >= 2)
      return { status: 'unavailable', code: 'broker_busy' };
    this.inFlight.set(context.installationId, (this.inFlight.get(context.installationId) ?? 0) + 1);
    let sent = false;
    let usedCredential: { handle: string; origin: string } | undefined;
    const operationSignal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
    const check = () => {
      operationSignal.throwIfAborted();
      const grant = this.store.assertAuthorization(
        context.installationId,
        context.revision,
        context.epoch,
        context.generation,
      );
      if (usedCredential) {
        const binding = this.store.credential(context.installationId, usedCredential.handle);
        if (
          !binding.active ||
          binding.origin !== usedCredential.origin ||
          !grant.grant.credentialHandles?.includes(usedCredential.handle)
        )
          throw Error('trace_credential_changed');
      }
      return grant;
    };
    try {
      let url: URL;
      try {
        url = new URL(parsed.data.url);
      } catch {
        return { status: 'unavailable', code: 'invalid_request' };
      }
      let method = parsed.data.method;
      let body = parsed.data.bodyBase64
        ? Buffer.from(parsed.data.bodyBase64, 'base64')
        : Buffer.alloc(0);
      if (
        body.length > 65536 ||
        (parsed.data.bodyBase64 && body.toString('base64') !== parsed.data.bodyBase64) ||
        (method === 'GET' && body.length) ||
        Object.values(parsed.data.headers ?? {}).some((value) =>
          [...value].some((character) => character.charCodeAt(0) < 32),
        )
      )
        return { status: 'unavailable', code: 'request_limit' };
      const credentialOrigin = url.origin;
      for (let hop = 0; hop <= 3; hop++) {
        usedCredential = undefined;
        const grant = check();
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          !grant.grant.origins.includes(url.origin)
        )
          return { status: 'unavailable', code: hop ? 'redirect_denied' : 'origin_denied' };
        let target: { address: string; family: 4 | 6 };
        try {
          target = await resolveTraceTarget(
            url,
            grant.grant.allowPrivateNetwork === true,
            operationSignal,
          );
        } catch (error) {
          if (error instanceof Error && error.message === 'trace_target_denied')
            return { status: 'unavailable', code: 'target_denied' };
          throw error;
        }
        check();
        const headers: Record<string, string> = {
          ...parsed.data.headers,
          'content-length': String(body.length),
          'accept-encoding': 'gzip,deflate,br',
        };
        if (parsed.data.credentialHandle && url.origin === credentialOrigin) {
          if (!this.credentials) return { status: 'unavailable', code: 'credential_unavailable' };
          try {
            Object.assign(
              headers,
              await this.credentials.headers({
                ...context,
                origin: url.origin,
                handle: parsed.data.credentialHandle,
              }),
            );
          } catch {
            return { status: 'unavailable', code: 'credential_unavailable' };
          }
          usedCredential = { handle: parsed.data.credentialHandle, origin: url.origin };
        }
        check();
        this.store.audit(context.installationId, 'http_send', 'allowed');
        const response = await new Promise<{
          status: number;
          location?: string;
          bytes: Buffer;
          encoding?: string;
        }>((resolve, reject) => {
          const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
            url,
            {
              method,
              headers,
              agent: false,
              signal: operationSignal,
              lookup: (_, __, callback) =>
                callback(null, [{ address: target.address, family: target.family }]),
            },
            (incoming) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              incoming.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                if (bytes > 65536) {
                  request.destroy(Error('response_limit'));
                  incoming.destroy();
                  return;
                }
                chunks.push(chunk);
              });
              incoming.on('error', reject);
              incoming.on('end', () =>
                resolve({
                  status: incoming.statusCode ?? 0,
                  ...(typeof incoming.headers.location === 'string'
                    ? { location: incoming.headers.location }
                    : {}),
                  ...(typeof incoming.headers['content-encoding'] === 'string'
                    ? { encoding: incoming.headers['content-encoding'] }
                    : {}),
                  bytes: Buffer.concat(chunks),
                }),
              );
            },
          );
          const timer = setTimeout(() => request.destroy(Error('request_timeout')), 5000);
          request.once('close', () => clearTimeout(timer));
          request.once('error', reject);
          // Last synchronous gate before bytes are given to the exact pinned request.
          try {
            check();
            sent = true;
            request.end(body);
          } catch (error) {
            request.destroy();
            reject(error);
          }
        });
        check();
        if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
          if (hop === 3) return { status: 'unavailable', code: 'redirect_denied' };
          url = new URL(response.location, url);
          if ([301, 302, 303].includes(response.status)) {
            method = 'GET';
            body = Buffer.alloc(0);
          }
          continue;
        }
        let bytes = response.bytes;
        if (response.encoding && response.encoding !== 'identity') {
          const options = { maxOutputLength: 65536 };
          if (response.encoding === 'gzip') bytes = gunzipSync(bytes, options);
          else if (response.encoding === 'deflate') bytes = inflateSync(bytes, options);
          else if (response.encoding === 'br') bytes = brotliDecompressSync(bytes, options);
          else return { status: 'unconfirmed', code: 'response_unavailable' };
        }
        if (bytes.length > 65536 || response.status < 100 || response.status > 599)
          return { status: 'unconfirmed', code: 'response_unavailable' };
        if (
          headers.authorization &&
          bytes.includes(Buffer.from(headers.authorization.replace(/^Bearer /, '')))
        ) {
          this.store.audit(context.installationId, 'http_send', 'unknown');
          return { status: 'unconfirmed', code: 'response_unavailable' };
        }
        return {
          status: 'complete',
          httpStatus: response.status,
          bodyBase64: bytes.toString('base64'),
        };
      }
      return { status: 'unavailable', code: 'redirect_denied' };
    } catch {
      this.store.audit(context.installationId, 'http_send', sent ? 'unknown' : 'denied');
      try {
        this.store.assertAuthorization(
          context.installationId,
          context.revision,
          context.epoch,
          context.generation,
        );
        if (context.signal.aborted) throw Error('revoked');
      } catch {
        return sent
          ? { status: 'unconfirmed', code: 'request_interrupted' }
          : { status: 'unavailable', code: 'permission_revoked' };
      }
      return sent
        ? { status: 'unconfirmed', code: 'request_interrupted' }
        : { status: 'unavailable', code: 'network_unavailable' };
    } finally {
      const remaining = (this.inFlight.get(context.installationId) ?? 1) - 1;
      if (remaining) this.inFlight.set(context.installationId, remaining);
      else this.inFlight.delete(context.installationId);
    }
  }
}
