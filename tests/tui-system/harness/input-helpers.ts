import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';
import { stripAnsi, waitForOutputQuiescence } from './terminal-screen';
import { tuiPollInterval, tuiWaitTimeout } from './timing';

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const INPUT_SETTLE_MS = 100;
const INPUT_ECHO_TIMEOUT_MS = 2_000;
const INPUT_DELIVERY_ATTEMPTS = 3;
const INPUT_RETRY_LIMIT = 256;
const INPUT_RETRY_BACKSPACE_DELAY_MS = 50;

function normalizeInputEcho(text: string): string {
  return stripAnsi(text).replace(/\s+/g, '');
}

type ActiveInput = {
  kind:
    | 'main'
    | 'session-search'
    | 'slash-query'
    | 'slash-argument-query'
    | 'file-query'
    | 'block-cursor';
  value: string;
};

function currentPromptInput(lines: readonly string[]): string | undefined {
  let promptLine = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\s*❯(?:\s|$)/.test(lines[index]!)) {
      promptLine = index;
      break;
    }
  }
  if (promptLine < 0) return undefined;

  const inputLines = [lines[promptLine]!.replace(/^\s*❯\s?/, '')];
  for (let index = promptLine + 1; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (/^[─━═╭╰┌└]/.test(trimmed) || /^(?:mock-model|\S+\s+·)/.test(trimmed)) break;
    inputLines.push(line);
  }
  return normalizeInputEcho(inputLines.join('\n'));
}

function activeInput(viewport: string): ActiveInput | undefined {
  const lines = stripAnsi(viewport).split(/\r?\n/);

  for (const [marker, command] of [
    ['模型匹配 "', '/model '],
    ['推理深度匹配 "', '/effort '],
    ['主题匹配 "', '/theme '],
    ['权限模式匹配 "', '/permissions '],
  ] as const) {
    const queryLine = lines.find((line) => line.includes(marker));
    if (queryLine) {
      const remainder = queryLine.slice(queryLine.indexOf(marker) + marker.length);
      const partial = remainder.slice(0, Math.max(0, remainder.indexOf('"')));
      return {
        kind: 'slash-argument-query',
        value: normalizeInputEcho(`${command}${partial}`),
      };
    }
  }

  for (const [marker, kind] of [
    ['命令匹配 ', 'slash-query'],
    ['文件匹配 ', 'file-query'],
  ] as const) {
    const queryLine = lines.find((line) => line.includes(marker));
    if (queryLine) {
      const value = queryLine
        .slice(queryLine.indexOf(marker) + marker.length)
        .replace(/\s*│?\s*$/, '')
        .trim();
      return { kind, value: normalizeInputEcho(value) };
    }
  }

  if (lines.some((line) => line.includes('会话列表'))) {
    const searchLine = lines.find((line) => line.includes('搜索:'));
    if (searchLine) {
      const value = searchLine
        .slice(searchLine.indexOf('搜索:') + '搜索:'.length)
        .replace(/\|?\s*│?\s*$/, '')
        .replace(/_$/, '')
        .trim();
      return { kind: 'session-search', value: normalizeInputEcho(value) };
    }
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cursorIndex = line.indexOf('█');
    if (cursorIndex >= 0) {
      return {
        kind: 'block-cursor',
        value: normalizeInputEcho(line.slice(0, cursorIndex).trim()),
      };
    }
  }

  const promptInput = currentPromptInput(lines);
  return promptInput === undefined ? undefined : { kind: 'main', value: promptInput };
}

async function waitForInputEcho(
  tui: PtyProcess,
  expectedValue: string,
  expectedKind: ActiveInput['kind'] | undefined,
  allowFocusTransfer: boolean,
  timeoutMs: number,
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    await tui.settleScreen();
    const current = activeInput(tui.viewport());
    if (
      current?.value === expectedValue &&
      (current.kind === expectedKind || (allowFocusTransfer && expectedValue.length > 0))
    ) {
      return;
    }
    await sleep(tuiPollInterval(25));
  }
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for active input value ${JSON.stringify(expectedValue)}`,
  );
}

async function clearActiveInputTo(
  tui: PtyProcess,
  targetValue: string,
  expectedKind: ActiveInput['kind'] | undefined,
): Promise<ActiveInput> {
  const effectiveTimeout = tuiWaitTimeout(5_000);
  const start = Date.now();
  let backspaces = 0;
  let lastInput: ActiveInput | undefined;
  let previousValue: string | undefined;
  while (Date.now() - start < effectiveTimeout && backspaces <= INPUT_RETRY_LIMIT) {
    await tui.settleScreen();
    const current = activeInput(tui.viewport());
    if (!current) {
      await sleep(tuiPollInterval(25));
      continue;
    }
    lastInput = current;
    if (
      current.kind === 'block-cursor' &&
      targetValue.length === 0 &&
      previousValue !== undefined &&
      current.value.length > previousValue.length
    ) {
      return { ...current, value: '' };
    }
    if (current.value === targetValue) return current;
    if (expectedKind !== undefined && current.kind !== expectedKind && targetValue.length > 0) {
      throw new Error(
        `Input focus changed from ${expectedKind} to ${current.kind} during append retry`,
      );
    }
    if (!current.value.startsWith(targetValue)) {
      throw new Error(
        `Cannot restore active input ${JSON.stringify(current.value)} to baseline ${JSON.stringify(targetValue)}`,
      );
    }
    previousValue = current.value;
    tui.write(current.kind === 'block-cursor' ? '\x08' : '\x7f');
    backspaces++;
    await sleep(INPUT_RETRY_BACKSPACE_DELAY_MS);
  }
  throw new Error(
    `Timeout restoring active input to ${JSON.stringify(targetValue)}; last active input was ${JSON.stringify(lastInput)}. ` +
      `Last terminal output:\n${stripAnsi(tui.transcript()).slice(-1_000)}`,
  );
}

export async function typeText(
  tui: PtyProcess,
  text: string,
  delayOrOptions: number | { append?: boolean; delayMs?: number } = 40,
): Promise<void> {
  if (text.length === 0) return;
  const options = typeof delayOrOptions === 'number' ? { delayMs: delayOrOptions } : delayOrOptions;
  const delayMs = options.delayMs ?? 40;
  await tui.settleScreen();
  let initial = activeInput(tui.viewport());
  if (!initial) {
    throw new Error('Cannot type text because no active input field is visible');
  }
  if (!options.append && initial.kind === 'block-cursor') {
    // First-run forms render their configured default as a placeholder even
    // after the logical field has been cleared, so the visible default is not
    // an append baseline. Their scenarios clear the field explicitly first.
    initial = { ...initial, value: '' };
  } else if (!options.append && initial.value.length > 0) {
    initial = await clearActiveInputTo(tui, '', initial.kind);
  }
  const baselineValue = options.append ? initial.value : '';
  const expectedValue = `${baselineValue}${normalizeInputEcho(text)}`;
  const characters = Array.from(text);
  const attempts = characters.length <= INPUT_RETRY_LIMIT ? INPUT_DELIVERY_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    for (const ch of characters) {
      tui.write(ch);
      await sleep(delayMs);
    }
    await sleep(INPUT_SETTLE_MS);

    try {
      // Confirm that Ink rendered the final input value before a following
      // control key is sent. The current VT viewport is authoritative here:
      // raw output retains erased Ink frames and can falsely acknowledge text
      // that is no longer present in the active input line.
      await waitForInputEcho(
        tui,
        expectedValue,
        initial.kind,
        !options.append && baselineValue.length === 0,
        INPUT_ECHO_TIMEOUT_MS,
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // Restore the exact pre-action baseline one visible character at a time.
      // This clears arbitrary partial delivery without deleting legitimate
      // content that an explicit append action intends to preserve.
      initial = await clearActiveInputTo(tui, baselineValue, initial.kind);
      await sleep(INPUT_SETTLE_MS);
    }
  }

  const tail = stripAnsi(tui.transcript()).slice(-1_000);
  throw new Error(
    `PTY input delivery failed after ${attempts} attempt(s) for ${JSON.stringify(text)}. Last output:\n${tail}`,
    { cause: lastError },
  );
}

/** Type into a masked field whose real value cannot be confirmed from PTY output. */
export async function typeMaskedText(tui: PtyProcess, text: string, delayMs = 40): Promise<void> {
  for (const character of Array.from(text)) {
    tui.write(character);
    await sleep(delayMs);
  }
}

export async function clearInput(
  tui: PtyProcess,
  length: number,
  options: { backspace?: 'delete' | 'ascii'; requireReceipt?: boolean } = {},
): Promise<void> {
  if (length <= 0) return;
  const outputMark = tui.markOutput();
  const backspace = options.backspace === 'ascii' ? '\x08' : '\x7f';
  for (let i = 0; i < length; i++) {
    tui.write(backspace);
    await sleep(50);
  }
  await waitForOutputQuiescence(
    () => tui.outputSince(outputMark),
    undefined,
    undefined,
    options.requireReceipt ?? true,
  );
}

export async function waitForRequestMessage(
  server: MockModelServer,
  text: string,
  timeout = 10000,
  options?: {
    since?: number;
    tui?: PtyProcess;
  },
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeout);
  const interval = tuiPollInterval(100);
  const since = options?.since ?? 0;
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (server.hasRequestMessage(text, since)) return;
    await sleep(interval);
  }
  const requestCount = server.getRequestCount();
  const requestTail = server
    .getRequests()
    .slice(since)
    .slice(-3)
    .map((request) => JSON.stringify(request.messages).slice(-500))
    .join('\n');
  const terminalTail = options?.tui
    ? stripAnsi(options.tui.transcript()).slice(-1_000)
    : 'unavailable';
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for model request containing "${text}". ` +
      `Saw ${requestCount - since} new request(s).\nRecent requests:\n${
        requestTail || 'none'
      }\nLast terminal output:\n${terminalTail}`,
  );
}

export async function submitUserMessage(
  tui: PtyProcess,
  server: MockModelServer,
  text: string,
  options?: {
    delayMs?: number;
    requestText?: string;
    timeout?: number;
  },
): Promise<void> {
  const since = server.getRequestCount();
  await typeText(tui, text, options?.delayMs);
  tui.write('\r');
  await waitForRequestMessage(server, options?.requestText ?? text, options?.timeout, {
    since,
    tui,
  });
}

export async function submitCommand(
  tui: PtyProcess,
  command: string,
  delayMs?: number,
): Promise<void> {
  await typeText(tui, command, delayMs);
  const expectedKind: ActiveInput['kind'] | undefined =
    /^\/(?:model|effort|theme|permissions)\s+\S/.test(command)
      ? 'slash-argument-query'
      : /^\/\S+$/.test(command)
        ? undefined
        : 'main';
  // A plain input echo can precede the React commit that updates the slash
  // suggestion refs consumed by Enter. Argument selectors require their exact
  // semantic suggestion frame; free-form arguments require the settled main
  // input. Exact no-argument commands are safe in either kind because the
  // same render computes slashMatched=true and no longer suppresses submit.
  await waitForInputEcho(
    tui,
    normalizeInputEcho(command),
    expectedKind,
    expectedKind === undefined,
    INPUT_ECHO_TIMEOUT_MS,
  );
  tui.write('\r');
}
