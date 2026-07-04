import type { MockModelServer } from './fixtures';
import { clearInput, sleep, typeText } from './input-helpers';
import type { PtyProcess } from './pty-process';
import { screenContains, stripAnsi } from './terminal-screen';

/**
 * Shared warmup for PTY E2E tests.
 *
 * Initializes the TUI input pipeline: validates raw-mode keystrokes reach
 * the input line, then confirms empty Enter does not trigger a model call.
 *
 * Call once per describe block as a test (beforeAll cannot assert).
 */
export async function warmupInputPipeline(tui: PtyProcess, server: MockModelServer): Promise<void> {
  // ── Validate raw-mode keystrokes reach the input line ──
  const text = 'hello';
  await typeText(tui, text, 80);
  await sleep(400);

  const output = tui.output();
  const clean = stripAnsi(output);
  if (!clean.includes(text)) {
    throw new Error(`Warmup failed: typed text "${text}" not found in TUI output`);
  }

  await clearInput(tui, text.length);

  // ── Validate empty Enter does not submit a message ──
  const before = server.getRequestCount();
  tui.write('\r');
  await sleep(500);

  if (!screenContains(tui.output(), '❯')) {
    throw new Error('Warmup failed: TUI prompt not visible after empty Enter');
  }
  if (server.getRequestCount() !== before) {
    throw new Error('Warmup failed: empty Enter triggered an unexpected model request');
  }
}
