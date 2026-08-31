import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';

export const WEB_SESSION_TTL_MS = 5 * 60_000;
export const WEB_MAX_SESSIONS = 128;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface WebGatewayAuthOptions {
  readonly instanceId: string;
  readonly cookiePath?: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxSessions?: number;
}

export interface WebGatewaySessionRegistry {
  readonly cookieName: string;
  createSession(): string | undefined;
  inspectCookie(
    cookieHeader: string | null,
  ):
    | { readonly status: 'absent' | 'invalid' }
    | { readonly status: 'valid'; readonly record: WebGatewaySessionRecord };
  revokeSession(cookieHash: string): void;
  close(): void;
}

export interface WebGatewaySessionRecord {
  readonly cookieHash: string;
  readonly expiresAt: number;
}

/**
 * Hash-only Browser-session authority for one Service instance. Plain cookie
 * values are never retained in the registry.
 */
export function createWebGatewayAuth(options: WebGatewayAuthOptions): WebGatewaySessionRegistry {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => systemRandomBytes(size));
  const maxSessions = positiveBound(options.maxSessions, WEB_MAX_SESSIONS, 'maxSessions');
  const cookiePath = options.cookiePath ?? '/_kite/web';
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(cookiePath)) {
    throw new TypeError('Web Gateway cookie path is invalid.');
  }
  const instanceId = boundedBinding(options.instanceId, 'instanceId');
  const cookieName = `kite_web_${digest(instanceId).slice(0, 24)}`;
  const sessions = new Map<string, WebGatewaySessionRecord>();
  let closed = false;

  const authority: WebGatewaySessionRegistry = {
    cookieName,
    createSession: () => createSession(safeNow(now)),
    inspectCookie,
    revokeSession(cookieHash) {
      sessions.delete(cookieHash);
    },
    close() {
      closed = true;
      sessions.clear();
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

  function createSession(current: number): string | undefined {
    if (closed) return undefined;
    cleanupExpired(current);
    if (sessions.size >= maxSessions) return undefined;
    const cookieValue = createToken(random);
    const expiresAt = expiry(current, WEB_SESSION_TTL_MS);
    const cookieHash = digest(`${instanceId}\0session\0${cookieValue}`);
    sessions.set(cookieHash, { cookieHash, expiresAt });
    return cookieHeader(cookieName, cookieValue, cookiePath, expiresAt);
  }

  function cleanupExpired(current: number): void {
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
