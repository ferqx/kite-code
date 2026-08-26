import { describe, expect, test } from 'bun:test';
import {
  createLocalBootstrapAuth,
  LOCAL_BOOTSTRAP_AUTHORIZATION_SCHEME,
  LOCAL_BOOTSTRAP_COOKIE_NAME,
  LOCAL_BOOTSTRAP_REJECT_CODE,
} from '#app/carrier/local-bootstrap-auth';

const ORIGIN = 'http://127.0.0.1:43123';
const HOST = '127.0.0.1:43123';

function fixture(options: { bootstrapTtlMs?: number; sessionTtlMs?: number } = {}) {
  let now = 1_000;
  let sequence = 0;
  const auth = createLocalBootstrapAuth({
    ...options,
    now: () => now,
    randomBytes(size) {
      const bytes = new Uint8Array(size);
      bytes.fill(++sequence);
      return bytes;
    },
  });
  return {
    auth,
    advance(ms: number) {
      now += ms;
    },
  };
}

function authorization(secret: string): string {
  return `${LOCAL_BOOTSTRAP_AUTHORIZATION_SCHEME} ${secret}`;
}

function bootstrap(auth: ReturnType<typeof createLocalBootstrapAuth>) {
  const result = auth.consumeBootstrap({
    authorization: authorization(auth.bootstrapBearer),
    origin: ORIGIN,
    host: HOST,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected bootstrap to succeed');
  return result.cookie;
}

describe('development loopback bootstrap auth', () => {
  test('consumes the bootstrap bearer exactly once and returns a strict short-lived cookie', () => {
    const { auth } = fixture({ sessionTtlMs: 1_001 });
    const secret = auth.bootstrapBearer;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const cookie = bootstrap(auth);
    expect(cookie.name).toBe(LOCAL_BOOTSTRAP_COOKIE_NAME);
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.value).not.toBe(secret);
    expect(cookie.setCookie).toBe(
      `${LOCAL_BOOTSTRAP_COOKIE_NAME}=${cookie.value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2`,
    );
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');

    expect(
      auth.consumeBootstrap({ authorization: authorization(secret), origin: ORIGIN, host: HOST }),
    ).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });
  });

  test('uses an indistinguishable public rejection for bad scheme, token, replay, or binding', () => {
    const { auth } = fixture();
    const rejected = [
      auth.consumeBootstrap({
        authorization: `Bearer ${auth.bootstrapBearer}`,
        origin: ORIGIN,
        host: HOST,
      }),
      auth.consumeBootstrap({
        authorization: authorization(`${auth.bootstrapBearer}x`),
        origin: ORIGIN,
        host: HOST,
      }),
      auth.consumeBootstrap({
        authorization: authorization(auth.bootstrapBearer),
        origin: '',
        host: HOST,
      }),
    ];
    const cookie = bootstrap(auth);
    rejected.push(
      auth.consumeBootstrap({
        authorization: authorization(auth.bootstrapBearer),
        origin: ORIGIN,
        host: HOST,
      }),
    );
    for (const result of rejected)
      expect(result).toEqual({ ok: false, code: LOCAL_BOOTSTRAP_REJECT_CODE });
    expect(cookie.value).not.toContain('Kite-Dev-Bootstrap');
  });

  test('binds WebSocket authorization to the exact origin and host, cookie parser, and expiry', () => {
    const { auth, advance } = fixture({ sessionTtlMs: 1_000 });
    const cookie = bootstrap(auth);
    const header = `${LOCAL_BOOTSTRAP_COOKIE_NAME}=${cookie.value}; theme=dark`;
    expect(auth.authorizeWebSocket({ cookie: header, origin: ORIGIN, host: HOST }).ok).toBe(true);
    expect(auth.authorizeWebSocket({ cookie: header, origin: `${ORIGIN}/`, host: HOST })).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });
    expect(
      auth.authorizeWebSocket({ cookie: header, origin: ORIGIN, host: 'localhost:43123' }),
    ).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });
    expect(
      auth.authorizeWebSocket({
        cookie: `${LOCAL_BOOTSTRAP_COOKIE_NAME}=${cookie.value}; ${LOCAL_BOOTSTRAP_COOKIE_NAME}=${cookie.value}`,
        origin: ORIGIN,
        host: HOST,
      }),
    ).toEqual({ ok: false, code: LOCAL_BOOTSTRAP_REJECT_CODE });
    expect(
      auth.authorizeWebSocket({
        cookie: `${LOCAL_BOOTSTRAP_COOKIE_NAME}=bad`,
        origin: ORIGIN,
        host: HOST,
      }),
    ).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });

    advance(1_000);
    expect(auth.authorizeWebSocket({ cookie: header, origin: ORIGIN, host: HOST })).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });
  });

  test('rejects cookies from an old process and clears all secret state on close', () => {
    const first = fixture();
    const cookie = bootstrap(first.auth);
    const restarted = fixture();
    const header = `${LOCAL_BOOTSTRAP_COOKIE_NAME}=${cookie.value}`;
    expect(
      restarted.auth.authorizeWebSocket({ cookie: header, origin: ORIGIN, host: HOST }),
    ).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });

    first.auth.close();
    expect(first.auth.bootstrapBearer).toBe('');
    expect(first.auth.authorizeWebSocket({ cookie: header, origin: ORIGIN, host: HOST })).toEqual({
      ok: false,
      code: LOCAL_BOOTSTRAP_REJECT_CODE,
    });
  });

  test('expires bootstrap material and enforces fixed TTL ceilings without exposing secrets in failures', () => {
    const { auth, advance } = fixture({ bootstrapTtlMs: 1_000 });
    const secret = auth.bootstrapBearer;
    advance(1_000);
    const rejected = auth.consumeBootstrap({
      authorization: authorization(secret),
      origin: ORIGIN,
      host: HOST,
    });
    expect(rejected).toEqual({ ok: false, code: LOCAL_BOOTSTRAP_REJECT_CODE });
    expect(JSON.stringify(rejected)).not.toContain(secret);
    auth.cleanup();
    expect(auth.bootstrapBearer).toBe('');
    expect(() => fixture({ sessionTtlMs: 10 * 60_000 + 1 })).toThrow(RangeError);
    expect(() => fixture({ bootstrapTtlMs: 5 * 60_000 + 1 })).toThrow(RangeError);
  });
});
