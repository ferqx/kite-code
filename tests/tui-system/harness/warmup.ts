import type { MockModelServer } from './fixtures';
import { clearInput, sleep, typeText } from './input-helpers';
import type { PtyProcess } from './pty-process';
import { screenContains, waitForText } from './terminal-screen';

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
  let inputReady = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await typeText(tui, text, 80);
    try {
      // A newly spawned Linux PTY can discard the first raw keystrokes while
      // Ink is still attaching its input listener. Clear and retry so a failed
      // warmup cannot leave partial input that contaminates later tests.
      await waitForText(() => tui.output(), text, 1500);
      inputReady = true;
      break;
    } catch {
      await clearInput(tui, text.length);
      await sleep(300);
    }
  }
  if (!inputReady) {
    throw new Error(`Warmup failed: typed text "${text}" not found after 3 attempts`);
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
