import { describe, expect, test } from 'bun:test';
import type { MockModelServer } from './fixtures';
import {
  clearInput,
  submitCommand,
  submitUserMessage,
  typeText,
  waitForRequestMessage,
} from './input-helpers';
import type { PtyProcess } from './pty-process';

const FAST_RETRY = {
  delayMs: 0,
  testTiming: {
    echoTimeoutMs: 20,
    settleMs: 0,
    retryBackspaceDelayMs: 0,
    restoreTimeoutMs: 100,
  },
} as const;

function fakePty(onWrite: (data: string) => void, output: () => string): PtyProcess {
  let lastActionMark = 0;
  return {
    exited: false,
    write(data) {
      lastActionMark = output().length;
      onWrite(data);
      return lastActionMark as ReturnType<PtyProcess['markOutput']>;
    },
    setRawMode() {
      lastActionMark = output().length;
      return lastActionMark as ReturnType<PtyProcess['markOutput']>;
    },
    resize() {
      lastActionMark = output().length;
      return lastActionMark as ReturnType<PtyProcess['markOutput']>;
    },
    viewport: () => `❯ ${output()}`,
    scrollback: output,
    transcript: output,
    settleScreen: async () => {},
    markScreen: () => 0 as ReturnType<PtyProcess['markScreen']>,
    screenFramesSince: () => [output()],
    markOutput: () => output().length as ReturnType<PtyProcess['markOutput']>,
    outputSince: (mark) => output().slice(mark),
    outputSinceLastAction: () => output().slice(lastActionMark),
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
        if (data === '\x7f') {
          rendered = rendered.slice(0, -1);
          return;
        }
        if (data === 'h') attempt++;
        if (attempt >= 2) rendered += data;
      },
      () => rendered,
    );

    await typeText(tui, 'hello', FAST_RETRY);

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

  test('typeText resets the input before retrying after an unrelated redraw', async () => {
    let transcript = '';
    let currentInput = '';
    let attempt = 0;
    let deletes = 0;
    const tui = fakePty(
      (data) => {
        if (data === '\x7f') {
          deletes++;
          currentInput = currentInput.slice(0, -1);
          return;
        }
        if (data === 'h') attempt++;
        if (attempt === 1) {
          transcript = '<prompt-redraw>';
          return;
        }
        currentInput += data;
        transcript += data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await typeText(tui, 'hello', FAST_RETRY);

    expect(attempt).toBe(2);
    expect(deletes).toBe(0);
    expect(currentInput).toBe('hello');
  }, 10_000);

  test('typeText rejects an erased transcript receipt and clears partial visible input', async () => {
    let transcript = '';
    let currentInput = '';
    let attempt = 0;
    const tui = fakePty(
      (data) => {
        if (data === '\x7f') {
          currentInput = currentInput.slice(0, -1);
          transcript += '<delete>';
          return;
        }
        if (data === '/') attempt++;
        transcript += data;
        if (attempt === 1) {
          currentInput = data === 'p' ? 'cp' : data;
          return;
        }
        currentInput += data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await typeText(tui, '/mcp', FAST_RETRY);

    expect(attempt).toBe(2);
    expect(currentInput).toBe('/mcp');
  }, 10_000);

  test('typeText clears a stale pre-action prefix before entering a command', async () => {
    let currentInput = 'cp';
    let transcript = '';
    const tui = fakePty(
      (data) => {
        transcript += data;
        currentInput = data === '\x7f' ? currentInput.slice(0, -1) : currentInput + data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await typeText(tui, '/mcp', 0);

    expect(currentInput).toBe('/mcp');
  });

  test('typeText restores a non-empty append baseline after partial delivery', async () => {
    let suffix = '';
    let transcript = '';
    let attempt = 0;
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          suffix = suffix.slice(0, -1);
          return;
        }
        if (data === 'L') attempt++;
        if (attempt >= 2 || suffix.length < 2) suffix += data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ Line1\n  ${suffix}`;

    await typeText(tui, 'Line2', { ...FAST_RETRY, append: true });

    expect(attempt).toBe(2);
    expect(suffix).toBe('Line2');
  }, 10_000);

  test('typeText follows the active session search instead of matching list content', async () => {
    let transcript = '';
    let searchInput = '';
    let attempt = 0;
    let deliveryCharacters = 0;
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          searchInput = searchInput.slice(0, -1);
          return;
        }
        if (deliveryCharacters % 'session 1'.length === 0) attempt++;
        deliveryCharacters++;
        if (attempt >= 2) searchInput += data;
      },
      () => transcript,
    );
    tui.viewport = () =>
      `╭────────╮\n│ 会话列表\n│ 搜索: ${searchInput}_\n│ > session 1\n╰────────╯`;

    await typeText(tui, 'session 1', FAST_RETRY);

    expect(attempt).toBe(2);
    expect(searchInput).toBe('session 1');
  }, 10_000);

  test('typeText does not accept a long message already present in history', async () => {
    const message =
      'This is a very long test message that exceeds one hundred characters and already appears in history';
    let currentInput = '';
    let transcript = '';
    let attempt = 0;
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          currentInput = currentInput.slice(0, -1);
          return;
        }
        if (data === 'T') attempt++;
        if (attempt >= 2) currentInput += data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${message}\n\nresponse\n────────\n❯ ${currentInput}`;

    await typeText(tui, message, FAST_RETRY);

    expect(attempt).toBe(2);
    expect(currentInput).toBe(message);
  }, 10_000);

  test('typeText rejects slash argument ghost text as an input receipt', async () => {
    const requested = '/permissions auto';
    const delivered = '/permissions a';
    let actual = '';
    let transcript = '';
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          actual = actual.slice(0, -1);
        } else if (actual.length < delivered.length) {
          actual += data;
        }
      },
      () => transcript,
    );
    tui.viewport = () => {
      if (actual.startsWith('/permissions ')) {
        const partial = actual.slice('/permissions '.length);
        return `❯ ${actual}${'auto'.slice(partial.length)}\n────────\n╭────╮\n│ 权限模式匹配 "${partial}"\n│ auto\n╰────╯`;
      }
      if (actual.startsWith('/')) {
        return `❯ ${actual}\n────────\n╭────╮\n│ 命令匹配 ${actual}\n│ /permissions\n╰────╯`;
      }
      return '❯ ';
    };

    await expect(typeText(tui, requested, FAST_RETRY)).rejects.toThrow('PTY input delivery failed');

    expect(actual).not.toBe(requested);
  }, 15_000);

  test('clearInput supports the input widget backspace encoding and waits for a receipt', async () => {
    let rendered = '';
    const writes: string[] = [];
    const tui = fakePty(
      (data) => {
        writes.push(data);
        rendered += '<rendered-backspace>';
      },
      () => rendered,
    );

    await clearInput(tui, 2, { backspace: 'ascii' });

    expect(writes).toEqual(['\x08', '\x08']);
  });

  test('clearInput can settle a retry cleanup when an already-empty widget emits no receipt', async () => {
    const tui = fakePty(
      () => {},
      () => '',
    );

    await clearInput(tui, 2, { requireReceipt: false });
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
      setModelsResponse() {},
      getModelRequests: () => [],
      assertComplete() {},
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
      setModelsResponse() {},
      getModelRequests: () => [],
      assertComplete() {},
      stop() {},
    } as MockModelServer;

    await submitUserMessage(tui, server, 'hello', { delayMs: 0, timeout: 100 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.content).toBe('hello');
  });

  test('submitCommand waits for the slash suggestion frame before pressing Enter', async () => {
    const command = '/permissions f';
    let currentInput = '';
    let rendered = '';
    let argumentReady = false;
    let argumentArrivedBeforeFocusTransfer = false;
    let suggestionReady = false;
    let submitted = false;
    const tui = fakePty(
      (data) => {
        if (data === '\r') {
          submitted = suggestionReady;
          if (submitted) currentInput = '';
          return;
        }
        if (currentInput === '/permissions ' && !argumentReady) {
          argumentArrivedBeforeFocusTransfer = true;
        }
        currentInput += data;
        rendered += data;
        if (currentInput === '/permissions ') {
          setTimeout(() => {
            argumentReady = true;
            rendered += '<permissions-argument-ready>';
          }, 100);
        }
        if (currentInput === command) {
          suggestionReady = true;
          rendered += '<permissions-suggestion>';
        }
      },
      () => rendered,
    );
    tui.viewport = () => {
      if (argumentReady && currentInput.startsWith('/permissions ')) {
        const query = currentInput.slice('/permissions '.length);
        return `❯ ${currentInput}\n╭────╮\n│ 权限模式匹配 "${query}"\n│ ${suggestionReady ? 'full' : ''}\n╰────╯`;
      }
      return `❯ ${currentInput}`;
    };

    await submitCommand(tui, command, 0, { submitReceiptTimeoutMs: 20 });

    expect(argumentArrivedBeforeFocusTransfer).toBe(false);
    expect(suggestionReady).toBe(true);
    expect(submitted).toBe(true);
  });

  test('submitCommand retries Enter until the active input leaves the submitted command', async () => {
    const command = '/compact marker';
    let currentInput = '';
    let enterAttempts = 0;
    const tui = fakePty(
      (data) => {
        if (data === '\r') {
          enterAttempts++;
          if (enterAttempts >= 2) currentInput = '';
          return;
        }
        currentInput += data;
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await submitCommand(tui, command, 0, { submitReceiptTimeoutMs: 20 });

    expect(enterAttempts).toBe(2);
    expect(currentInput).toBe('');
  });

  test('typeText retries the complete selector transaction when focus transfer is missed', async () => {
    const command = '/permissions f';
    let currentInput = '';
    let deliveries = 0;
    let argumentReady = false;
    const tui = fakePty(
      (data) => {
        if (data === '\x7f') {
          currentInput = currentInput.slice(0, -1);
          return;
        }
        if (data === '/' && currentInput.length === 0) {
          deliveries++;
          argumentReady = deliveries >= 2;
        }
        currentInput += data;
      },
      () => currentInput,
    );
    tui.viewport = () =>
      argumentReady && currentInput.startsWith('/permissions ')
        ? `❯ ${currentInput}\n╭────╮\n│ 权限模式匹配 "${currentInput.slice('/permissions '.length)}"\n│ full\n╰────╯`
        : `❯ ${currentInput}`;

    await typeText(tui, command, FAST_RETRY);

    expect(deliveries).toBe(2);
    expect(currentInput).toBe(command);
  }, 10_000);
});
