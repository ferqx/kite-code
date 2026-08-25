import { describe, expect, test } from 'bun:test';
import type { MockModelServer } from './fixtures';
import {
  activateSessionSearch,
  activeInput,
  clearInput,
  pasteText,
  submitCommand,
  submitCurrentInput,
  submitUserMessage,
  typeText,
  waitForRequestMessage,
} from './input-helpers';
import type { PtyProcess } from './pty-process';
import { createHeadlessTerminalScreen } from './terminal-screen';

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
    async writeExact(data) {
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
    inputViewport() {
      return this.viewport();
    },
    focusedMainInputReady: () => true,
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
  test('pasteText delivers one exact transaction when the receipt is observed', async () => {
    let currentInput = '';
    let attempts = 0;
    const tui = fakePty(
      (data) => {
        if (!data.startsWith('\x1b[200~')) return;
        attempts++;
        currentInput = 'Line1\nLine2';
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await pasteText(tui, 'Line1\nLine2', { echoTimeoutMs: 20, settleMs: 0 });

    expect(attempts).toBe(1);
    expect(currentInput).toBe('Line1\nLine2');
  });

  test('pasteText waits for the focused main input handler before dispatching', async () => {
    let currentInput = '';
    let ready = false;
    let readyWhenWritten = false;
    const writes: string[] = [];
    const tui = fakePty(
      (data) => {
        writes.push(data);
        if (data === '~') {
          if (ready) currentInput = '~';
          return;
        }
        if (data === '\x7f') {
          currentInput = currentInput.slice(0, -1);
          return;
        }
        if (!data.startsWith('\x1b[200~')) return;
        readyWhenWritten = ready;
        currentInput = 'Ready message';
      },
      () => currentInput,
    );
    (tui as PtyProcess & { focusedMainInputReady(): boolean }).focusedMainInputReady = () => ready;
    tui.viewport = () => `❯ ${currentInput}`;
    setTimeout(() => {
      ready = true;
    }, 5);

    await pasteText(tui, 'Ready message', { echoTimeoutMs: 50, settleMs: 0 });

    expect(readyWhenWritten).toBe(true);
    expect(writes).toEqual(['\x1b[200~Ready message\x1b[201~']);
  });

  test('pasteText never replays an unacknowledged transaction', async () => {
    let attempts = 0;
    let logicalInput = '';
    const tui = fakePty(
      (data) => {
        if (!data.startsWith('\x1b[200~')) return;
        attempts++;
        logicalInput += data.slice('\x1b[200~'.length, -'\x1b[201~'.length);
      },
      // Simulate Ink having consumed the paste while a delayed VT projection
      // still looks empty. Replaying here would duplicate logical user input.
      () => '',
    );

    await expect(
      pasteText(tui, 'Line1\nLine2', { echoTimeoutMs: 20, settleMs: 0 }),
    ).rejects.toThrow('no exact receipt; refusing replay');

    expect(attempts).toBe(1);
    expect(logicalInput).toBe('Line1\nLine2');
  });

  test('pasteText refuses to replay a partial transaction', async () => {
    let currentInput = '';
    let attempts = 0;
    const tui = fakePty(
      (data) => {
        if (!data.startsWith('\x1b[200~')) return;
        attempts++;
        currentInput = 'Line1';
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await expect(
      pasteText(tui, 'Line1\nLine2', { echoTimeoutMs: 20, settleMs: 0 }),
    ).rejects.toThrow('refusing replay');

    expect(attempts).toBe(1);
  });

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

    await typeText(tui, 'long wrapped input', { delayMs: 0, append: true });

    expect(rendered).toContain('\r\n');
  });

  test('typeText retries an appended transaction when PTY delivery drops a word-boundary space', async () => {
    let rendered = '';
    let attempt = 0;
    const tui = fakePty(
      (data) => {
        if (data === '\x7f') {
          rendered = rendered.slice(0, -1);
          return;
        }
        if (data === 'o' && rendered.length === 0) attempt++;
        if (attempt === 1 && data === ' ') return;
        rendered += data;
      },
      () => rendered,
    );

    await typeText(tui, 'one hundred', { ...FAST_RETRY, append: true });

    expect(attempt).toBe(2);
    expect(rendered).toBe('one hundred');
  });

  test('typeText resets an empty replacement transaction after an unrelated redraw', async () => {
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
    expect(deletes).toBeGreaterThan(0);
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

  test('typeText clears leading whitespace that would change the submitted input kind', async () => {
    let currentInput = ' ';
    let transcript = '';
    const tui = fakePty(
      (data) => {
        transcript += data;
        currentInput = data === '\x7f' ? currentInput.slice(0, -1) : currentInput + data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await typeText(tui, '/compact marker', 0);

    expect(currentInput).toBe('/compact marker');
  });

  test('typeText retry removes whitespace left behind by a partial delivery', async () => {
    let currentInput = '';
    let transcript = '';
    let attempts = 0;
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          currentInput = currentInput.slice(0, -1);
          return;
        }
        if (data === 'A') attempts++;
        if (attempts === 1 && data !== ' ') return;
        currentInput += data;
      },
      () => transcript,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await typeText(tui, 'Ask me', { ...FAST_RETRY, append: true });

    expect(attempts).toBe(2);
    expect(currentInput).toBe('Ask me');
  });

  test('headless terminal input projection removes the end cursor but preserves a leading blank', async () => {
    const screen = createHeadlessTerminalScreen(40, 3);
    try {
      await screen.append(new TextEncoder().encode('❯ \x1b[7m \x1b[27m'));
      expect(activeInput(screen.inputViewport())?.value).toBe('');

      await screen.append(new TextEncoder().encode('\r\x1b[2K❯  \x1b[7m \x1b[27m'));
      expect(activeInput(screen.inputViewport())?.value).toBe(' ');

      await screen.append(new TextEncoder().encode('\r\x1b[2K❯  x\x1b[7m \x1b[27m'));
      expect(activeInput(screen.inputViewport())?.value).toBe(' x');
    } finally {
      screen.dispose();
    }
  });

  test('main input projection restores omitted word-wrap spaces without splitting hard wraps', async () => {
    const wordWrapScreen = createHeadlessTerminalScreen(40, 4);
    const hardWrapScreen = createHeadlessTerminalScreen(40, 4);
    try {
      await wordWrapScreen.append(
        new TextEncoder().encode(`❯ one\r\n  hundred\x1b[7m \x1b[27m\r\n${'─'.repeat(20)}`),
      );
      expect(activeInput(wordWrapScreen.inputViewport())?.value).toBe('one hundred');

      await hardWrapScreen.append(
        new TextEncoder().encode(`❯ abcde\r\n  f\x1b[7m \x1b[27m\r\n${'─'.repeat(8)}`),
      );
      expect(activeInput(hardWrapScreen.inputViewport())?.value).toBe('abcdef');
    } finally {
      wordWrapScreen.dispose();
      hardWrapScreen.dispose();
    }
  });

  test('activeInput ignores a slash overlay selected row below the real prompt', () => {
    const viewport = [
      '────────────────────',
      '❯ /rewind',
      '────────────────────',
      'mock-model · [接受编辑]',
      '',
      '── 命令匹配 ── 1 / 1 ──',
      '',
      '  ❯ /rewind    回退检查点并恢复文件',
      '',
      ' ↑↓ 导航  Enter 确认',
    ].join('\n');

    expect(activeInput(viewport)).toEqual({ kind: 'slash-query', value: '/rewind' });
  });

  test('activeInput recognizes a unified empty slash-argument selector', () => {
    const viewport = [
      '❯ /theme ',
      '────────────────────',
      '── 主题选项 ── 1 / 5 ──',
      '  ❯ teal',
      '    purple',
    ].join('\n');

    expect(activeInput(viewport)).toEqual({ kind: 'slash-argument-query', value: '/theme ' });
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
    const tui = fakePty(
      (data) => {
        transcript += data;
        if (data === '\x7f') {
          searchInput = searchInput.slice(0, -1);
          return;
        }
        if (data === 's' && searchInput.length === 0) attempt++;
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

  test('activeInput does not treat the inactive session-search placeholder as editable text', () => {
    const viewport = [
      '❯ stale main prompt',
      '────────',
      '── 会话列表 ── 1 / 1 ──',
      '    搜索: —',
      '  ❯ session 1                     2026-08-04 09:30:00',
    ].join('\n');

    expect(activeInput(viewport)).toBeUndefined();
    expect(activeInput(viewport.replace('    搜索: —', '  ❯ 搜索:'))).toEqual({
      kind: 'session-search',
      value: '',
    });
  });

  test('activeInput excludes overlay result metadata from a file query', () => {
    expect(activeInput('── 文件匹配 package ── 1 / 1 ──')).toEqual({
      kind: 'file-query',
      value: 'package',
    });
  });

  test('activateSessionSearch moves selection from the first session row to search', async () => {
    let active = false;
    const tui = fakePty(
      (data) => {
        if (data === '\x1b[A') active = true;
      },
      () => '',
    );
    tui.viewport = () =>
      `── 会话列表 ── 1 / 1 ──\n${active ? '  ❯ 搜索:' : '    搜索: —'}\n  ❯ session 1`;
    tui.inputViewport = tui.viewport;

    await activateSessionSearch(tui, 100);

    expect(active).toBe(true);
  });

  test('activateSessionSearch does not assume the first session row is selected', async () => {
    let selected = 2;
    let upWrites = 0;
    const tui = fakePty(
      (data) => {
        if (data !== '\x1b[A') return;
        upWrites += 1;
        selected = Math.max(-1, selected - 1);
      },
      () => '',
    );
    tui.viewport = () =>
      `── 会话列表 ── 3 / 3 ──\n${selected === -1 ? '  ❯ 搜索:' : '    搜索: —'}\n${selected === 0 ? '  ❯' : '   '} session 1\n${selected === 1 ? '  ❯' : '   '} session 2\n${selected === 2 ? '  ❯' : '   '} session 3`;
    tui.inputViewport = tui.viewport;

    await activateSessionSearch(tui, 250);

    expect(selected).toBe(-1);
    expect(upWrites).toBe(3);
  });

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

    await typeText(tui, message, { ...FAST_RETRY, append: true });

    expect(attempt).toBe(2);
    expect(currentInput).toBe(message);
  }, 10_000);

  test('typeText rejects slash argument ghost text as an input receipt', async () => {
    const requested = '/theme blue';
    const delivered = '/theme b';
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
      if (actual.startsWith('/theme ')) {
        const partial = actual.slice('/theme '.length);
        return `❯ ${actual}${'blue'.slice(partial.length)}\n────────\n╭────╮\n│ 主题匹配 "${partial}"\n│ blue\n╰────╯`;
      }
      if (actual.startsWith('/')) {
        return `❯ ${actual}\n────────\n╭────╮\n│ 命令匹配\n│ /theme\n╰────╯`;
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

  test('clearInput retry cleanup does not require a quiet window from a live status display', async () => {
    const tui = fakePty(
      () => {},
      () => 'continuously changing status output',
    );
    tui.outputSince = () => {
      throw new Error('retry cleanup must not wait for global output quiescence');
    };

    await clearInput(tui, 2, { requireReceipt: false, delayMs: 0 });
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
      hasRequestMessage: (text: string, since: number) =>
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
    let currentInput = '';
    const tui = fakePty(
      (data) => {
        if (data === '\r') {
          requests.push({ body: {}, messages: [{ content: pending }] });
          pending = '';
          currentInput = '';
          return;
        }
        pending += data;
        currentInput += data;
        rendered += data;
      },
      () => rendered,
    );
    tui.viewport = () => `❯ ${currentInput}`;
    const server = {
      baseURL: 'http://127.0.0.1/v1',
      port: 0,
      setResponses() {},
      getRequestCount: () => requests.length,
      getRequests: () => requests,
      hasRequestMessage: (text: string, since: number) =>
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

  test('submitCurrentInput retries Enter until the active field advances', async () => {
    let currentInput = 'typed value';
    let enterAttempts = 0;
    const tui = fakePty(
      (data) => {
        if (data !== '\r') return;
        enterAttempts++;
        if (enterAttempts >= 2) currentInput = '';
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await submitCurrentInput(tui, { submitReceiptTimeoutMs: 20 });

    expect(enterAttempts).toBe(2);
    expect(currentInput).toBe('');
  });

  test('submitCurrentInput stops before a control key can cross into a new modal', async () => {
    const currentInput = 'blocked message';
    let modalVisible = false;
    let enterAttempts = 0;
    const tui = fakePty(
      (data) => {
        if (data !== '\r') return;
        enterAttempts++;
        if (enterAttempts === 1) modalVisible = true;
      },
      () => currentInput,
    );
    tui.viewport = () =>
      modalVisible ? `❯ ${currentInput}\n▶ 1. Session Waive` : `❯ ${currentInput}`;

    await submitCurrentInput(tui, {
      submitReceiptTimeoutMs: 20,
      acceptWhen: (viewport) => viewport.includes('Session Waive'),
    });

    expect(enterAttempts).toBe(1);
    expect(modalVisible).toBe(true);
  });

  test('submitCurrentInput waits without another Enter after the field clears', async () => {
    let currentInput = 'submitted message';
    let accepted = false;
    let enterAttempts = 0;
    const tui = fakePty(
      (data) => {
        if (data !== '\r') return;
        enterAttempts++;
        currentInput = '';
        setTimeout(() => {
          accepted = true;
        }, 30);
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}`;

    await submitCurrentInput(tui, {
      submitReceiptTimeoutMs: 10,
      semanticReceiptTimeoutMs: 100,
      acceptWhen: () => accepted,
      requireAcceptWhen: true,
    });

    expect(enterAttempts).toBe(1);
  });

  test('submitCurrentInput fails safely when a changed field gets no semantic receipt', async () => {
    let currentInput = 'submitted message';
    let enterAttempts = 0;
    const tui = fakePty(
      (data) => {
        if (data !== '\r') return;
        enterAttempts++;
        currentInput = '';
      },
      () => currentInput,
    );
    tui.viewport = () => `❯ ${currentInput}\n▶ 1. New modal action`;

    await expect(
      submitCurrentInput(tui, {
        submitReceiptTimeoutMs: 20,
        semanticReceiptTimeoutMs: 20,
        acceptWhen: () => false,
        requireAcceptWhen: true,
      }),
    ).rejects.toThrow('required semantic receipt did not arrive');

    expect(enterAttempts).toBe(1);
  });

  test('submitCurrentInput rejects a required receipt without a predicate', async () => {
    const tui = fakePty(
      () => {},
      () => 'message',
    );
    await expect(submitCurrentInput(tui, { requireAcceptWhen: true })).rejects.toThrow(
      'requires acceptWhen',
    );
  });

  test('submitCommand waits for the slash suggestion frame before pressing Enter', async () => {
    const command = '/theme p';
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
        if (currentInput === '/theme ' && !argumentReady) {
          argumentArrivedBeforeFocusTransfer = true;
        }
        currentInput += data;
        rendered += data;
        if (currentInput === '/theme ') {
          setTimeout(() => {
            argumentReady = true;
            rendered += '<theme-argument-ready>';
          }, 100);
        }
        if (currentInput === command) {
          suggestionReady = true;
          rendered += '<theme-suggestion>';
        }
      },
      () => rendered,
    );
    tui.viewport = () => {
      if (argumentReady && currentInput.startsWith('/theme ')) {
        const query = currentInput.slice('/theme '.length);
        return `❯ ${currentInput}\n╭────╮\n│ 主题匹配 "${query}"\n│ ${suggestionReady ? 'purple' : ''}\n╰────╯`;
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
    const command = '/theme p';
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
      argumentReady && currentInput.startsWith('/theme ')
        ? `❯ ${currentInput}\n╭────╮\n│ 主题匹配 "${currentInput.slice('/theme '.length)}"\n│ purple\n╰────╯`
        : `❯ ${currentInput}`;

    await typeText(tui, command, FAST_RETRY);

    expect(deliveries).toBe(2);
    expect(currentInput).toBe(command);
  }, 10_000);
});
