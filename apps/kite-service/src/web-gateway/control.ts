import {
  KITE_WEB_CONTROL_AUTHORIZATION_SCHEME,
  KITE_WEB_CONTROL_RESPONSE_SCHEMA_,
  KITE_WEB_NATIVE_MINT_PATH,
  KITE_WEB_NATIVE_STOP_PATH,
} from './carrier';

const CONTROL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/u;
const MAX_CONTROL_RESPONSE_BYTES = 2_048;
const DEFAULT_CONTROL_DEADLINE_MS = 2_000;

export interface WebGatewayControlLink {
  mintLaunchUrl(): Promise<string>;
  stop(): Promise<void>;
}

export interface WebGatewayControlLinkOptions {
  readonly origin: string;
  readonly credential: string;
  readonly expectedInstanceId: string;
  readonly expectedBuildId: string;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly deadlineMs?: number;
}

/**
 * Exact native link used only after process/descriptor identity has been
 * validated by the Gateway manager. It cannot call a Browser or Runtime use
 * case and it never sends Cookie, Origin, Fetch Metadata, or query material.
 */
export function createWebGatewayControlLink(
  options: WebGatewayControlLinkOptions,
): WebGatewayControlLink {
  if (!LOOPBACK_ORIGIN_PATTERN.test(options.origin)) {
    throw new TypeError('Web Gateway control origin is invalid.');
  }
  if (!CONTROL_CREDENTIAL_PATTERN.test(options.credential)) {
    throw new TypeError('Web Gateway control credential is invalid.');
  }
  safeIdentity(options.expectedInstanceId);
  safeIdentity(options.expectedBuildId);
  const deadlineMs = options.deadlineMs ?? DEFAULT_CONTROL_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new RangeError('Web Gateway control deadline is invalid.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  return Object.freeze({
    async mintLaunchUrl() {
      const response = await request('mint_launch', KITE_WEB_NATIVE_MINT_PATH);
      if (
        !hasExactKeys(response, [
          'buildId',
          'gatewayInstanceId',
          'launchUrl',
          'operation',
          'origin',
          'schema',
        ]) ||
        typeof response.launchUrl !== 'string' ||
        !new RegExp(`^${escapePattern(options.origin)}/#[A-Za-z0-9_-]{43}$`, 'u').test(
          response.launchUrl,
        )
      ) {
        throw unavailable();
      }
      return response.launchUrl;
    },
    async stop() {
      const response = await request('stop', KITE_WEB_NATIVE_STOP_PATH);
      if (
        !hasExactKeys(response, ['buildId', 'gatewayInstanceId', 'operation', 'origin', 'schema'])
      ) {
        throw unavailable();
      }
    },
  });

  async function request(
    operation: 'mint_launch' | 'stop',
    pathname: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const result = await fetchImpl(`${options.origin}${pathname}`, {
        method: 'POST',
        headers: {
          authorization: `${KITE_WEB_CONTROL_AUTHORIZATION_SCHEME} ${options.credential}`,
          'content-type': 'application/json',
        },
        body: '{}',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (
        result.status !== 200 ||
        result.headers.get('content-type') !== 'application/json; charset=utf-8'
      ) {
        throw unavailable();
      }
      const value = await readBoundedJson(result);
      if (
        !isPlainObject(value) ||
        value.schema !== KITE_WEB_CONTROL_RESPONSE_SCHEMA_ ||
        value.operation !== operation ||
        value.gatewayInstanceId !== options.expectedInstanceId ||
        value.buildId !== options.expectedBuildId ||
        value.origin !== options.origin
      ) {
        throw unavailable();
      }
      return value;
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES)
  ) {
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_CONTROL_RESPONSE_BYTES) {
      await reader.cancel();
      throw unavailable();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeIdentity(value: string): void {
  if (!value || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new TypeError('Web Gateway control identity is invalid.');
  }
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function unavailable(): Error {
  return new Error('Web Gateway native control is unavailable.');
}
