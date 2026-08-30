import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';

export const WEB_LAUNCH_TOKEN_TTL_MS = 30_000;
export const WEB_SESSION_TTL_MS = 5 * 60_000;
export const WEB_MAX_LAUNCH_TOKENS = 128;
export const WEB_MAX_SESSIONS = 128;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface WebGatewayAuthOptions {
  readonly instanceId: string;
  readonly origin: string;
  readonly cookiePath?: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxLaunchTokens?: number;
  readonly maxSessions?: number;
}

export interface WebGatewayLaunch {
  readonly url: string;
  mintLaunchUrl(): string;
  consume(token: string, replaceCookieHash?: string): WebGatewaySessionMaterial | undefined;
  close(): void;
}

export interface WebGatewaySessionMaterial {
  readonly cookieName: string;
  readonly cookieValue: string;
  readonly cookieHash: string;
  readonly setCookie: string;
  readonly expiresAt: number;
}

export interface WebGatewaySessionRegistry {
  readonly cookieName: string;
  authorize(cookieHeader: string | null): WebGatewaySessionRecord | undefined;
  inspectCookie(
    cookieHeader: string | null,
  ):
    | { readonly status: 'absent' | 'invalid' }
    | { readonly status: 'valid'; readonly record: WebGatewaySessionRecord };
  consumeLaunch(token: string, replaceCookieHash?: string): WebGatewaySessionMaterial | undefined;
  revokeSession(cookieHash: string): void;
  cleanup(): void;
  close(): void;
}

export interface WebGatewaySessionRecord {
  readonly cookieHash: string;
  readonly expiresAt: number;
}

/**
 * Hash-only launch/session authority for one Gateway instance. Plain launch
 * and cookie values are never retained in the registry; the launch value is
 * only present in the caller-owned URL fragment and request body exchange.
 */
export function createWebGatewayAuth(
  options: WebGatewayAuthOptions,
): WebGatewaySessionRegistry & WebGatewayLaunch {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => systemRandomBytes(size));
  const maxLaunchTokens = positiveBound(
    options.maxLaunchTokens,
    WEB_MAX_LAUNCH_TOKENS,
    'maxLaunchTokens',
  );
  const maxSessions = positiveBound(options.maxSessions, WEB_MAX_SESSIONS, 'maxSessions');
  const cookiePath = options.cookiePath ?? '/_kite/web';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(cookiePath)) {
    throw new TypeError('Web Gateway cookie path is invalid.');
  }
  const instanceId = boundedBinding(options.instanceId, 'instanceId');
  const origin = boundedBinding(options.origin, 'origin');
  const cookieName = `kite_web_${digest(instanceId).slice(0, 24)}`;
  const launches = new Map<string, number>();
  const sessions = new Map<string, WebGatewaySessionRecord>();
  let closed = false;
  let launchUrl = '';

  issueLaunch();

  const authority: WebGatewaySessionRegistry & WebGatewayLaunch = {
    get url() {
      return launchUrl;
    },
    cookieName,
    mintLaunchUrl: issueLaunch,
    consume(token, replaceCookieHash) {
      return consumeLaunch(token, replaceCookieHash);
    },
    consumeLaunch,
    authorize(cookieHeader) {
      const inspected = inspectCookie(cookieHeader);
      return inspected.status === 'valid' ? inspected.record : undefined;
    },
    inspectCookie,
    revokeSession(cookieHash) {
      sessions.delete(cookieHash);
    },
    cleanup() {
      cleanupExpired(safeNow(now));
    },
    close() {
      closed = true;
      launches.clear();
      sessions.clear();
      launchUrl = '';
    },
  };
  return Object.freeze(authority);

  function inspectCookie(
    cookieHeader: string | null,
  ):
    | { readonly status: 'absent' | 'invalid' }
    | { readonly status: 'valid'; readonly record: WebGatewaySessionRecord } {
    if (closed) return { status: 'invalid' };
    const parsed = parseCurrentCookie(cookieHeader, cookieName);
    if (parsed.status !== 'value') return parsed;
    const current = safeNow(now);
    const cookieHash = digest(`${instanceId}\0session\0${parsed.value}`);
    const record = sessions.get(cookieHash);
    if (record === undefined || current >= record.expiresAt) {
      if (record !== undefined) sessions.delete(cookieHash);
      return { status: 'invalid' };
    }
    return { status: 'valid', record };
  }

  function issueLaunch(): string {
    const current = safeNow(now);
    cleanupExpired(current);
    if (launches.size >= maxLaunchTokens) {
      throw new RangeError('Web Gateway launch registry is full.');
    }
    const token = createToken(random);
    const expiresAt = expiry(current, WEB_LAUNCH_TOKEN_TTL_MS);
    const launchHash = digest(`${instanceId}\0launch\0${token}`);
    if (launches.has(launchHash)) {
      throw new Error('Web Gateway launch token source repeated material.');
    }
    launches.set(launchHash, expiresAt);
    launchUrl = `${origin}/#${token}`;
    return launchUrl;
  }

  function consumeLaunch(
    token: string,
    replaceCookieHash?: string,
  ): WebGatewaySessionMaterial | undefined {
    if (closed || !TOKEN_PATTERN.test(token)) return undefined;
    const current = safeNow(now);
    cleanupExpired(current);
    const launchHash = digest(`${instanceId}\0launch\0${token}`);
    const launchExpiry = launches.get(launchHash);
    if (launchExpiry === undefined || current >= launchExpiry) {
      if (launchExpiry !== undefined) launches.delete(launchHash);
      return undefined;
    }
    if (
      sessions.size >= maxSessions &&
      (replaceCookieHash === undefined || !sessions.has(replaceCookieHash))
    ) {
      return undefined;
    }
    launches.delete(launchHash);
    if (replaceCookieHash !== undefined) sessions.delete(replaceCookieHash);
    const cookieValue = createToken(random);
    const expiresAt = expiry(current, WEB_SESSION_TTL_MS);
    const cookieHash = digest(`${instanceId}\0session\0${cookieValue}`);
    sessions.set(cookieHash, { cookieHash, expiresAt });
    return {
      cookieName,
      cookieValue,
      cookieHash,
      expiresAt,
      setCookie: cookieHeader(cookieName, cookieValue, cookiePath, expiresAt),
    };
  }

  function cleanupExpired(current: number): void {
    for (const [hash, expiresAt] of launches) {
      if (current >= expiresAt) launches.delete(hash);
    }
    for (const [hash, record] of sessions) {
      if (current >= record.expiresAt) sessions.delete(hash);
    }
  }
}

function parseCurrentCookie(
  header: string | null,
  cookieName: string,
):
  | { readonly status: 'absent' | 'invalid' }
  | { readonly status: 'value'; readonly value: string } {
  if (header === null || header.length === 0) return { status: 'absent' };
  let value: string | undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    if (value !== undefined) return { status: 'invalid' };
    const candidate = part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(candidate)) return { status: 'invalid' };
    value = candidate;
  }
  return value === undefined ? { status: 'absent' } : { status: 'value', value };
}

function cookieHeader(name: string, value: string, path: string, expiresAt: number): string {
  const expires = new Date(expiresAt).toUTCString();
  return `${name}=${value}; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1_000)}; Expires=${expires}; Path=${path}; HttpOnly; SameSite=Strict`;
}

function createToken(random: (size: number) => Uint8Array): string {
  const bytes = random(TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
    throw new TypeError('Web Gateway random source must return exactly 32 bytes.');
  }
  const value = Buffer.from(bytes).toString('base64url');
  bytes.fill(0);
  if (!TOKEN_PATTERN.test(value)) throw new TypeError('Web Gateway token encoding failed.');
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedBinding(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError(`Web Gateway ${label} is invalid.`);
  }
  return value;
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be positive.`);
  return value;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Web Gateway clock is invalid.');
  return value;
}

function expiry(now: number, ttl: number): number {
  const value = now + ttl;
  if (!Number.isSafeInteger(value)) throw new RangeError('Web Gateway expiry exceeds safe time.');
  return value;
}
