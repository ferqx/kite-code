import { describe, expect, test } from 'bun:test';
import {
  createWebGatewayAuth,
  WEB_LAUNCH_TOKEN_TTL_MS,
  WEB_SESSION_TTL_MS,
} from '../../src/web-gateway';

function deterministicBytes(): (size: number) => Uint8Array {
  let generation = 0;
  return (size) => {
    generation += 1;
    return new Uint8Array(size).fill(generation);
  };
}

describe('Web Gateway launch and cookie authority', () => {
  test('expires launch and session material at exact absolute boundaries', () => {
    let clock = 1_000;
    const auth = createWebGatewayAuth({
      instanceId: 'gateway-auth-1',
      origin: 'http://127.0.0.1:43123',
      now: () => clock,
      randomBytes: deterministicBytes(),
    });
    const expiredLaunch = new URL(auth.url).hash.slice(1);
    clock += WEB_LAUNCH_TOKEN_TTL_MS;
    expect(auth.consumeLaunch(expiredLaunch)).toBeUndefined();

    clock += 1;
    const currentLaunch = new URL(auth.mintLaunchUrl()).hash.slice(1);
    const session = auth.consumeLaunch(currentLaunch);
    if (session === undefined) throw new Error('session was not issued');
    const cookie = `${session.cookieName}=${session.cookieValue}`;
    expect(session.setCookie).toContain('HttpOnly; SameSite=Strict');
    expect(session.setCookie).toContain('Path=/_kite/web');
    expect(session.setCookie).not.toContain('Secure');
    expect(auth.authorize(cookie)?.cookieHash).toBe(session.cookieHash);
    clock = session.expiresAt;
    expect(auth.authorize(cookie)).toBeUndefined();
    expect(session.expiresAt).toBe(1_000 + WEB_LAUNCH_TOKEN_TTL_MS + 1 + WEB_SESSION_TTL_MS);
  });

  test('binds launch material to one instance and treats duplicate current cookies as invalid', () => {
    const random = deterministicBytes();
    const first = createWebGatewayAuth({
      instanceId: 'gateway-auth-first',
      origin: 'http://127.0.0.1:43123',
      randomBytes: random,
    });
    const second = createWebGatewayAuth({
      instanceId: 'gateway-auth-second',
      origin: 'http://127.0.0.1:43124',
      randomBytes: random,
    });
    const firstToken = new URL(first.url).hash.slice(1);
    expect(second.consumeLaunch(firstToken)).toBeUndefined();
    const session = first.consumeLaunch(firstToken);
    if (session === undefined) throw new Error('session was not issued');
    const cookie = `${session.cookieName}=${session.cookieValue}`;
    expect(first.inspectCookie(`${cookie}; ${cookie}`)).toEqual({ status: 'invalid' });
    expect(first.inspectCookie('unrelated=value')).toEqual({ status: 'absent' });
  });

  test('allows a valid rotation at capacity and revokes the replaced cookie', () => {
    const auth = createWebGatewayAuth({
      instanceId: 'gateway-auth-capacity',
      origin: 'http://127.0.0.1:43123',
      randomBytes: deterministicBytes(),
      maxSessions: 1,
    });
    const first = auth.consumeLaunch(new URL(auth.url).hash.slice(1));
    if (first === undefined) throw new Error('first session was not issued');
    const second = auth.consumeLaunch(
      new URL(auth.mintLaunchUrl()).hash.slice(1),
      first.cookieHash,
    );
    if (second === undefined) throw new Error('rotated session was not issued');
    expect(auth.authorize(`${first.cookieName}=${first.cookieValue}`)).toBeUndefined();
    expect(auth.authorize(`${second.cookieName}=${second.cookieValue}`)?.cookieHash).toBe(
      second.cookieHash,
    );
  });
});
