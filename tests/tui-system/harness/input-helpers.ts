import type { MockModelServer } from './fixtures';
import type { PtyProcess } from './pty-process';

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const INPUT_SETTLE_MS = 200;

export async function typeText(tui: PtyProcess, text: string, delayMs = 40): Promise<void> {
  for (const ch of text) {
    tui.write(ch);
    await sleep(delayMs);
  }
  // Keep the final character and a following control key in separate PTY
  // delivery/render cycles. On slower Linux CI runners, writing Enter
  // immediately after the last character can leave the command in the input
  // buffer, so the next test appends to it (for example `/compact/new`).
  await sleep(INPUT_SETTLE_MS);
}

export async function clearInput(tui: PtyProcess, length: number): Promise<void> {
  for (let i = 0; i < length; i++) {
    tui.write('\x7f');
    await sleep(50);
  }
  await sleep(300);
}

export async function waitForRequestMessage(
  server: MockModelServer,
  text: string,
  timeout = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (server.hasRequestMessage(text)) return;
    await sleep(100);
  }
  const requestCount = server.getRequestCount();
  throw new Error(
    `Timeout (${timeout}ms) waiting for model request containing "${text}". Saw ${requestCount} requests.`,
  );
}
