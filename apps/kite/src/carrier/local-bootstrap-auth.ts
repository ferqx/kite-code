import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from 'node:crypto';

/** Development-carrier-only cookie name. It is deliberately not a general login session. */
export const LOCAL_BOOTSTRAP_COOKIE_NAME = 'kite_dev_session';
export const LOCAL_BOOTSTRAP_AUTHORIZATION_SCHEME = 'Kite-Dev-Bootstrap';
export const LOCAL_BOOTSTRAP_REJECT_CODE = 'unauthorized' as const;

const TOKEN_BYTES = 32;
const DEFAULT_BOOTSTRAP_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 5 * 60_000;
const MAX_BOOTSTRAP_TTL_MS = 5 * 60_000;
const MAX_SESSION_TTL_MS = 10 * 60_000;
const MAX_BINDING_LENGTH = 512;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type LocalBootstrapAuthResult =
  | Readonly<{ ok: true; cookie: LocalBootstrapCookieMaterial }>
  | Readonly<{ ok: false; code: typeof LOCAL_BOOTSTRAP_REJECT_CODE }>;

export type LocalWebSocketAuthorizationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: typeof LOCAL_BOOTSTRAP_REJECT_CODE }>;

export type LocalBootstrapCookieMaterial = Readonly<{
  name: typeof LOCAL_BOOTSTRAP_COOKIE_NAME;
  value: string;
  setCookie: string;
  httpOnly: true;
  sameSite: 'Strict';
  path: '/';
  maxAgeSeconds: number;
  expiresAt: number;
}>;

export type LocalBootstrapAuthOptions = Readonly<{
  /** Injectable only for deterministic carrier conformance tests. */
  randomBytes?: (size: number) => Uint8Array;
  /** Injectable only for deterministic carrier conformance tests. */
  now?: () => number;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
}>;

export type LocalBootstrapRequest = Readonly<{
  authorization: string | null | undefined;
  /** Verified by the App carrier before this method is called. Bound byte-for-byte. */
  origin: string;
  /** Verified by the App carrier before this method is called. Bound byte-for-byte. */
  host: string;
}>;

export type LocalWebSocketAuthorization = Readonly<{
  cookie: string | null | undefined;
  /** Verified by the App carrier before this method is called. */
  origin: string;
  /** Verified by the App carrier before this method is called. */
  host: string;
}>;

export type LocalBootstrapAuth = Readonly<{
  /** Bearer material for the one POST /_kite/bootstrap request. Never log or put it in a URL/body. */
  readonly bootstrapBearer: string;
  consumeBootstrap(input: LocalBootstrapRequest): LocalBootstrapAuthResult;
  authorizeWebSocket(input: LocalWebSocketAuthorization): LocalWebSocketAuthorizationResult;
  cleanup(): void;
  close(): void;
}>;

type SessionRecord = {
  tokenHash: Buffer;
  origin: string;
  host: string;
  expiresAt: number;
};

const REJECTED: LocalBootstrapAuthResult = Object.freeze({
  ok: false,
  code: LOCAL_BOOTSTRAP_REJECT_CODE,
});

/**
 * Creates the local, per-process bootstrap authority used by the development
 * loopback carrier. The carrier owns loopback/Host/Origin validation; this
 * module owns secret comparison, one-time consumption, and cookie binding.
 */
export function createLocalBootstrapAuth(
  options: LocalBootstrapAuthOptions = {},
): LocalBootstrapAuth {
  const random = options.randomBytes ?? systemRandomBytes;
  const now = options.now ?? Date.now;
  const bootstrapTtlMs = boundedTtl(
    options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS,
    MAX_BOOTSTRAP_TTL_MS,
    'bootstrapTtlMs',
  );
  const sessionTtlMs = boundedTtl(
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    MAX_SESSION_TTL_MS,
    'sessionTtlMs',
  );
  const startedAt = safeNow(now);
  let bootstrapBearer = createToken(random);
  const expectedAuthorization = Buffer.from(
    `${LOCAL_BOOTSTRAP_AUTHORIZATION_SCHEME} ${bootstrapBearer}`,
    'utf8',
  );
  let bootstrapExpiresAt = expiresAt(startedAt, bootstrapTtlMs);
  let session: SessionRecord | undefined;
  let closed = false;

  return Object.freeze({
    get bootstrapBearer() {
      return bootstrapBearer;
    },
    consumeBootstrap(input) {
      // Compare before considering lifecycle state so invalid scheme/token and
      // replayed material have the same public rejection shape.
      const matches = constantTimeAuthorizationMatches(input.authorization, expectedAuthorization);
      const current = safeNow(now);
      const bindingValid = isBinding(input.origin) && isBinding(input.host);
      if (
        !matches ||
        !bindingValid ||
        closed ||
        bootstrapBearer.length === 0 ||
        current >= bootstrapExpiresAt
      ) {
        return REJECTED;
      }

      // This synchronous transition is atomic with respect to Bun's event loop:
      // a second request cannot observe the bootstrap secret as usable.
      bootstrapBearer = '';
      expectedAuthorization.fill(0);
      bootstrapExpiresAt = 0;
      clearSession(session);

      const value = createToken(random);
      const expiresAtValue = expiresAt(current, sessionTtlMs);
      session = {
        tokenHash: hashToken(value),
        origin: input.origin,
        host: input.host,
        expiresAt: expiresAtValue,
      };
      return Object.freeze({
        ok: true,
        cookie: cookieMaterial(value, expiresAtValue, sessionTtlMs),
      });
    },
    authorizeWebSocket(input) {
      const value = sessionCookieValue(input.cookie);
      const candidateHash = hashToken(value ?? '');
      const record = session;
      const current = safeNow(now);
      const tokenMatches =
        record !== undefined &&
        timingSafeEqual(record.tokenHash, candidateHash) &&
        value !== undefined;
      candidateHash.fill(0);

      if (
        !tokenMatches ||
        !isBinding(input.origin) ||
        !isBinding(input.host) ||
        record === undefined ||
        record.origin !== input.origin ||
        record.host !== input.host ||
        current >= record.expiresAt ||
        closed
      ) {
        if (record !== undefined && current >= record.expiresAt) clearCurrentSession();
        return REJECTED;
      }
      // WebSocket admission only proves an existing cookie; it never returns
      // cookie material again.
      return Object.freeze({ ok: true });
    },
    cleanup() {
      const current = safeNow(now);
      if (bootstrapBearer.length > 0 && current >= bootstrapExpiresAt) clearBootstrap();
      if (session !== undefined && current >= session.expiresAt) clearCurrentSession();
    },
    close() {
      closed = true;
      clearBootstrap();
      clearCurrentSession();
    },
  });

  function clearBootstrap(): void {
    bootstrapBearer = '';
    expectedAuthorization.fill(0);
    bootstrapExpiresAt = 0;
  }

  function clearCurrentSession(): void {
    clearSession(session);
    session = undefined;
  }
}

function boundedTtl(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be a positive safe integer no greater than its fixed maximum.`,
    );
  }
  return value;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Local bootstrap auth clock must return a non-negative safe integer.');
  }
  return value;
}

function expiresAt(now: number, ttlMs: number): number {
  const value = now + ttlMs;
  if (!Number.isSafeInteger(value))
    throw new RangeError('Local bootstrap auth expiry exceeds safe time.');
  return value;
}

function randomToken(random: (size: number) => Uint8Array): Buffer {
  const bytes = random(TOKEN_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== TOKEN_BYTES) {
    throw new TypeError('Local bootstrap auth random source must return exactly 32 bytes.');
  }
  return Buffer.from(bytes);
}

function createToken(random: (size: number) => Uint8Array): string {
  const bytes = randomToken(random);
  const token = encodeToken(bytes);
  bytes.fill(0);
  return token;
}

function encodeToken(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function hashToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeAuthorizationMatches(
  authorization: string | null | undefined,
  expected: Buffer,
): boolean {
  const supplied = Buffer.from(typeof authorization === 'string' ? authorization : '', 'utf8');
  const padded = Buffer.alloc(expected.byteLength);
  supplied.copy(padded, 0, 0, Math.min(supplied.byteLength, padded.byteLength));
  const matches = timingSafeEqual(expected, padded) && supplied.byteLength === expected.byteLength;
  padded.fill(0);
  supplied.fill(0);
  return matches;
}

function isBinding(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BINDING_LENGTH;
}

function sessionCookieValue(cookie: string | null | undefined): string | undefined {
  if (typeof cookie !== 'string' || cookie.length === 0) return undefined;
  let value: string | undefined;
  for (const part of cookie.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) return undefined;
    const name = trimmed.slice(0, separator);
    const candidate = trimmed.slice(separator + 1);
    if (name !== LOCAL_BOOTSTRAP_COOKIE_NAME) continue;
    if (value !== undefined || !BASE64URL_TOKEN.test(candidate)) return undefined;
    value = candidate;
  }
  return value;
}

function cookieMaterial(
  value: string,
  expiresAtValue: number,
  ttlMs: number,
): LocalBootstrapCookieMaterial {
  const maxAgeSeconds = Math.max(1, Math.ceil(ttlMs / 1_000));
  return Object.freeze({
    name: LOCAL_BOOTSTRAP_COOKIE_NAME,
    value,
    setCookie: `${LOCAL_BOOTSTRAP_COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`,
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAgeSeconds,
    expiresAt: expiresAtValue,
  });
}

function clearSession(record: SessionRecord | undefined): void {
  record?.tokenHash.fill(0);
}
