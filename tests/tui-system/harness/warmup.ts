import type { MockModelServer } from './fixtures';
import { clearInput, sleep, typeText } from './input-helpers';
import type { PtyProcess } from './pty-process';
import { screenContains } from './terminal-screen';

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
  // typeText performs the same receipt-confirmed delivery used by every later
  // submission, including bounded recovery when the first raw keystrokes are
  // lost while Ink attaches or restores focus.
  await typeText(tui, text, 80);

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
