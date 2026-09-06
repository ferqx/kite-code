import { describe, expect, test } from 'bun:test';
import { createWebGatewayAuth, WEB_SESSION_TTL_MS } from '../../src/web-gateway';

function deterministicBytes(): (size: number) => Uint8Array {
  let generation = 0;
  return (size) => {
    generation += 1;
    return new Uint8Array(size).fill(generation);
  };
}

describe('Web Gateway cookie authority', () => {
  test('creates a root-navigation Browser session without minting a launch token', () => {
    const auth = createWebGatewayAuth({
      instanceId: 'gateway-auth-root',
      randomBytes: deterministicBytes(),
    });
    const setCookie = auth.createSession();
    if (!setCookie) throw new Error('root session was not issued');
    expect(setCookie).toContain('HttpOnly; SameSite=Strict');
    expect(auth.inspectCookie(setCookie.split(';', 1)[0]!)).toMatchObject({ status: 'valid' });
  });

  test('expires session material at the exact absolute boundary', () => {
    let clock = 1_000;
    const auth = createWebGatewayAuth({
      instanceId: 'gateway-auth-1',
      now: () => clock,
      randomBytes: deterministicBytes(),
    });
    const setCookie = auth.createSession();
    if (setCookie === undefined) throw new Error('session was not issued');
    const cookie = setCookie.split(';', 1)[0]!;
    expect(setCookie).toContain('HttpOnly; SameSite=Strict');
    expect(setCookie).toContain('Path=/_kite/web');
    expect(setCookie).not.toContain('Secure');
    const inspected = auth.inspectCookie(cookie);
    if (inspected.status !== 'valid') throw new Error('session was not authorized');
    expect(inspected.record.expiresAt).toBe(1_000 + WEB_SESSION_TTL_MS);
    clock = inspected.record.expiresAt;
    expect(auth.inspectCookie(cookie).status).toBe('invalid');
  });

  test('binds session material to one instance and treats duplicate current cookies as invalid', () => {
    const random = deterministicBytes();
    const first = createWebGatewayAuth({
      instanceId: 'gateway-auth-first',
      randomBytes: random,
    });
    const second = createWebGatewayAuth({
      instanceId: 'gateway-auth-second',
      randomBytes: random,
    });
    const setCookie = first.createSession();
    if (setCookie === undefined) throw new Error('session was not issued');
    const cookie = setCookie.split(';', 1)[0]!;
    expect(second.inspectCookie(cookie).status).toBe('absent');
    expect(first.inspectCookie(`${cookie}; ${cookie}`)).toEqual({ status: 'invalid' });
    expect(first.inspectCookie('unrelated=value')).toEqual({ status: 'absent' });
  });

  test('fails closed at capacity without revoking an existing session', () => {
    const auth = createWebGatewayAuth({
      instanceId: 'gateway-auth-capacity',
      randomBytes: deterministicBytes(),
      maxSessions: 1,
    });
    const first = auth.createSession();
    if (first === undefined) throw new Error('first session was not issued');
    expect(auth.createSession()).toBeUndefined();
    expect(auth.inspectCookie(first.split(';', 1)[0]!).status).toBe('valid');
  });
});
