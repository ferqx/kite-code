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

function inputEchoProbe(text: string): string {
  const characters = Array.from(text);
  return characters.length <= 64 ? text : characters.slice(-32).join('');
}

function normalizeInputEcho(text: string): string {
  return stripAnsi(text).replace(/\s+/g, '');
}

function containsInputFragment(output: string, text: string): boolean {
  const normalizedOutput = normalizeInputEcho(output);
  const normalizedText = normalizeInputEcho(text);
  const fragmentLength = Math.min(3, normalizedText.length);
  if (fragmentLength === 0) return false;
  for (let start = 0; start <= normalizedText.length - fragmentLength; start++) {
    if (normalizedOutput.includes(normalizedText.slice(start, start + fragmentLength))) return true;
  }
  return false;
}

async function waitForInputEcho(
  getOutput: () => string,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const effectiveTimeout = tuiWaitTimeout(timeoutMs);
  const normalizedProbe = normalizeInputEcho(text);
  const start = Date.now();
  while (Date.now() - start < effectiveTimeout) {
    if (normalizeInputEcho(getOutput()).includes(normalizedProbe)) return;
    await sleep(tuiPollInterval(25));
  }
  throw new Error(
    `Timeout (${effectiveTimeout}ms) waiting for normalized input echo ${JSON.stringify(text)}`,
  );
}

export async function typeText(tui: PtyProcess, text: string, delayMs = 40): Promise<void> {
  if (text.length === 0) return;
  const characters = Array.from(text);
  const echoProbe = inputEchoProbe(text);
  const attempts = characters.length <= INPUT_RETRY_LIMIT ? INPUT_DELIVERY_ATTEMPTS : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outputMark = tui.markOutput();
    for (const ch of characters) {
      tui.write(ch);
      await sleep(delayMs);
    }
    await sleep(INPUT_SETTLE_MS);

    try {
      // Confirm that Ink rendered the final input value before a following
      // control key is sent. Every input action owns this readiness check
      // because modal and input-line remounts can change focus after startup.
      await waitForInputEcho(() => tui.outputSince(outputMark), echoProbe, INPUT_ECHO_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      // A completely missing receipt means nothing reached the controlled
      // input, so there is no stale text to erase before retrying.
      const attemptedOutput = tui.outputSince(outputMark);
      if (containsInputFragment(attemptedOutput, text)) {
        await clearInput(tui, characters.length, { requireReceipt: false });
      }
      await sleep(INPUT_SETTLE_MS);
    }
  }

  const tail = stripAnsi(tui.transcript()).slice(-1_000);
  throw new Error(
    `PTY input delivery failed after ${attempts} attempt(s) for ${JSON.stringify(
      echoProbe,
    )}. Last output:\n${tail}`,
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
  tui.write('\r');
}
