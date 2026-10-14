import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  desktopContentSecurityPolicy,
  parseDesktopDevelopment,
  parseDevelopmentServiceReload,
  serveDevelopmentReload,
} from '../electron/development';

const configuration = {
  rendererUrl: 'http://127.0.0.1:43219/',
  cspNonce: 'a'.repeat(32),
  control: { port: 43220, token: 'b'.repeat(64) },
};

test('only explicit development accepts a canonical loopback renderer and limits CSP to its nonce and websocket', () => {
  expect(parseDesktopDevelopment(null, false)).toBeNull();
  expect(() => parseDesktopDevelopment(configuration, false)).toThrow();
  const parsed = parseDesktopDevelopment(configuration, true)!;
  expect(parsed).toEqual(configuration);
  const policy = desktopContentSecurityPolicy(parsed);
  expect(policy).toContain(`script-src 'self' 'nonce-${configuration.cspNonce}'`);
  expect(policy).toContain("connect-src 'self' ws://127.0.0.1:43219");
  expect(policy).not.toContain('unsafe-eval');
  expect(policy).not.toContain(configuration.control.token);
  expect(desktopContentSecurityPolicy(null)).toContain("connect-src 'none'");
  for (const rendererUrl of [
    'https://127.0.0.1:43219/',
    'http://localhost:43219/',
    'http://0.0.0.0:43219/',
    'http://127.0.0.1/',
    'http://127.0.0.1:43219/foreign',
    'http://127.0.0.1:43219/?token=secret',
    'http://user@127.0.0.1:43219/',
  ])
    expect(() => parseDesktopDevelopment({ ...configuration, rendererUrl }, true)).toThrow();
  expect(() =>
    parseDesktopDevelopment({ ...configuration, cspNonce: "'unsafe-inline'" }, true),
  ).toThrow();
  expect(() => parseDesktopDevelopment({ ...configuration, extra: true }, true)).toThrow();
});

test('parent reload protocol rejects arbitrary paths and serializes the actual reload operation', async () => {
  const stream = new PassThrough(),
    replies: string[] = [],
    calls: string[] = [];
  let finish: (() => void) | undefined;
  const stop = serveDevelopmentReload({
    stream,
    reply: (line) => replies.push(line),
    async reload(request) {
      calls.push(request.id);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  const request = { kind: 'service.reload', id: 'a'.repeat(32), sha256: 'b'.repeat(64) };
  expect(parseDevelopmentServiceReload(request)).toEqual({
    id: request.id,
    sha256: request.sha256,
  });
  for (const value of [
    { ...request, path: '/foreign' },
    { ...request, id: '../foreign' },
    { ...request, kind: 'execute' },
    { ...request, sha256: 'not-a-hash' },
  ]) {
    expect(() => parseDevelopmentServiceReload(value)).toThrow();
    stream.write(`${JSON.stringify(value)}\n`);
  }
  expect(calls).toEqual([]);
  const frame = `${JSON.stringify(request)}\n`;
  stream.write(frame.slice(0, 20));
  expect(calls).toEqual([]);
  stream.write(frame.slice(20));
  expect(calls).toEqual([request.id]);
  stream.write(`${JSON.stringify({ ...request, id: 'c'.repeat(32) })}\n`);
  expect(JSON.parse(replies[0]!)).toEqual({
    kind: 'service.reloaded',
    id: 'c'.repeat(32),
    ok: false,
  });
  finish!();
  await Bun.sleep(1);
  expect(JSON.parse(replies[1]!)).toEqual({ kind: 'service.reloaded', id: request.id, ok: true });
  stop();
  stream.write(frame);
  expect(calls).toHaveLength(1);
  stream.destroy();
});
