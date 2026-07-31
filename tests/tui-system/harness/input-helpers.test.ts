import { describe, expect, test } from 'bun:test';
import type { MockModelServer } from './fixtures';
import { submitUserMessage, typeText, waitForRequestMessage } from './input-helpers';
import type { PtyProcess } from './pty-process';

function fakePty(onWrite: (data: string) => void, output: () => string): PtyProcess {
  return {
    exited: false,
    write: onWrite,
    setRawMode() {},
    resize() {},
    output,
    waitForExit: async () => 0,
    kill() {},
    killAndWait: async () => true,
  };
}

describe('TUI input helpers', () => {
  test('typeText retries when the first PTY delivery is not rendered', async () => {
    let rendered = '';
    let attempt = 0;
    const tui = fakePty(
      (data) => {
        if (data === '\x7f') return;
        if (data === 'h') attempt++;
        if (attempt >= 2) rendered += data;
      },
      () => rendered,
    );

    await typeText(tui, 'hello', 0);

    expect(attempt).toBe(2);
    expect(rendered).toContain('hello');
  }, 10_000);

  test('typeText accepts terminal-wrapped input echo', async () => {
    let rendered = '';
    const tui = fakePty(
      (data) => {
        rendered += data === ' ' ? '\r\n  ' : data;
      },
      () => rendered,
    );

    await typeText(tui, 'long wrapped input', 0);

    expect(rendered).toContain('\r\n');
  });

  test('waitForRequestMessage ignores matching requests before the supplied baseline', async () => {
    const requests = [
      { body: {}, messages: [{ content: 'target' }] },
      { body: {}, messages: [{ content: 'other' }] },
    ];
    const server = {
      baseURL: 'http://127.0.0.1/v1',
      port: 0,
      setResponses() {},
      getRequestCount: () => requests.length,
      getRequests: () => requests,
      hasRequestMessage: (text: string, since = 0) =>
        requests
          .slice(since)
          .some((request) => request.messages.some((message) => message.content.includes(text))),
      stop() {},
    } as MockModelServer;

    await expect(waitForRequestMessage(server, 'target', 10, { since: 1 })).rejects.toThrow(
      'Saw 1 new request(s)',
    );
  });

  test('submitUserMessage confirms both terminal receipt and a new model request', async () => {
    let rendered = '';
    const requests: Array<{ body: Record<string, never>; messages: Array<{ content: string }> }> =
      [];
    let pending = '';
    const tui = fakePty(
      (data) => {
        if (data === '\r') {
          requests.push({ body: {}, messages: [{ content: pending }] });
          pending = '';
          return;
        }
        pending += data;
        rendered += data;
      },
      () => rendered,
    );
    const server = {
      baseURL: 'http://127.0.0.1/v1',
      port: 0,
      setResponses() {},
      getRequestCount: () => requests.length,
      getRequests: () => requests,
      hasRequestMessage: (text: string, since = 0) =>
        requests
          .slice(since)
          .some((request) => request.messages.some((message) => message.content.includes(text))),
      stop() {},
    } as MockModelServer;

    await submitUserMessage(tui, server, 'hello', { delayMs: 0, timeout: 100 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toBe('hello');
  });
});
