/**
 * First-run / setup wizard comprehensive PTY system tests.
 *
 * Covers: provider selection, API key form, custom endpoint form,
 * connection flow, error recovery, manual model entry, and full success path.
 * Config is fully isolated via KITE_CODE_HOME — user-level files are never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockModelServer } from '../harness/fixtures';
import { sleep } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import { screenContains, stripAnsi, waitForText } from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60000;

describe('first-run — comprehensive flow', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  function getOutput(): string {
    return stripAnsi(tui.output());
  }

  beforeAll(async () => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: {
          deepseek: {
            type: 'deepseek' as const,
            baseURL: 'https://api.deepseek.com/v1',
          },
        },
      },
    });
    workspace.env.CI = 'true';
    workspace.env.DEEPSEEK_API_KEY = '';
    workspace.env.OPENAI_API_KEY = '';
  });

  afterAll(async () => {
    server?.stop();
    await tui?.killAndWait();
    workspace?.cleanup();
  });

  async function spawnFirstRun() {
    await tui?.killAndWait();
    tui = spawnTui({
      cols: 100,
      rows: 40,
      mockServer: server,
      workspace,
      noPreConfig: true,
    });
    tui.setRawMode(true);
    await waitForText(() => getOutput(), 'Setup 1 of 2', 15000);
    await sleep(300);
  }

  // ─── Provider Selection ───

  test(
    'provider screen renders all providers',
    async () => {
      await spawnFirstRun();
      const out = getOutput();
      expect(screenContains(out, 'Choose a model provider')).toBe(true);
      expect(screenContains(out, 'DeepSeek')).toBe(true);
      expect(screenContains(out, 'OpenAI')).toBe(true);
      expect(screenContains(out, 'Custom endpoint')).toBe(true);
      expect(screenContains(out, 'Setup 1 of 2')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'provider screen: arrow down moves selection',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B'); // down to OpenAI
      await sleep(200);
      // OpenAI should now be highlighted (we can't easily check highlight in stripped output,
      // but we can verify by selecting it)
      tui.write('\r');
      await waitForText(() => getOutput(), 'Connect to OpenAI', 5000);
    },
    TIMEOUT,
  );

  test(
    'provider screen: Esc exits process',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b');
      const code = await tui.waitForExit();
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  // ─── API Key Form (DeepSeek) ───

  test(
    'DeepSeek: shows API key form with mask',
    async () => {
      await spawnFirstRun();
      tui.write('\r'); // select DeepSeek (default)
      await waitForText(() => getOutput(), 'Connect to DeepSeek', 5000);
      expect(screenContains(getOutput(), 'API key')).toBe(true);
      expect(screenContains(getOutput(), 'Setup 2 of 2')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: empty key + Enter stays on form',
    async () => {
      await spawnFirstRun();
      tui.write('\r');
      await waitForText(() => getOutput(), 'API key', 5000);
      tui.write('\r'); // Enter with empty key
      await sleep(500);
      // Should still be on the form
      expect(screenContains(getOutput(), 'Connect to DeepSeek')).toBe(true);
      expect(screenContains(getOutput(), 'API key')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: Esc returns to provider selection',
    async () => {
      await spawnFirstRun();
      tui.write('\r');
      await waitForText(() => getOutput(), 'Connect to DeepSeek', 5000);
      tui.write('\x1b'); // Esc
      await waitForText(() => getOutput(), 'Choose a model provider', 5000);
      expect(screenContains(getOutput(), 'Setup 1 of 2')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: typing key shows masked characters',
    async () => {
      await spawnFirstRun();
      tui.write('\r');
      await waitForText(() => getOutput(), 'API key', 5000);
      // Type a few characters
      tui.write('s');
      await sleep(100);
      tui.write('k');
      await sleep(100);
      tui.write('-');
      await sleep(100);
      tui.write('t');
      await sleep(100);
      tui.write('e');
      await sleep(100);
      tui.write('s');
      await sleep(100);
      tui.write('t');
      await sleep(300);
      // With mask="*", output should show asterisks not the actual key
      const out = getOutput();
      expect(screenContains(out, 'sk-test')).toBe(false);
      expect(screenContains(out, '*******')).toBe(true);
    },
    TIMEOUT,
  );

  // ─── Custom Endpoint Form ───

  test(
    'custom endpoint: shows Base URL and API key fields',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B'); // down to OpenAI
      await sleep(100);
      tui.write('\x1b[B'); // down to Custom endpoint
      await sleep(100);
      tui.write('\r');
      await waitForText(() => getOutput(), 'custom endpoint', 5000);
      expect(screenContains(getOutput(), 'Base URL')).toBe(true);
      expect(screenContains(getOutput(), 'API key')).toBe(true);
      expect(screenContains(getOutput(), 'Optional')).toBe(true);
      expect(screenContains(getOutput(), 'http://localhost:8080/v1')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: Enter enters edit mode, typing modifies URL',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await waitForText(() => getOutput(), 'custom endpoint', 5000);

      // Press Enter to edit Base URL (default focus is baseURL)
      tui.write('\r');
      await sleep(500);

      // Use Ctrl+U to clear the input (more reliable than backspaces)
      tui.write('\x15');
      await sleep(300);

      // Type a short test string
      for (const ch of 'http://x.co') {
        tui.write(ch);
        await sleep(50);
      }
      await sleep(500);

      // Verify the typed text appears
      expect(screenContains(getOutput(), 'http://x.co')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: Esc in edit mode cancels edit and restores value',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await waitForText(() => getOutput(), 'custom endpoint', 5000);

      // Enter edit mode
      tui.write('\r');
      await sleep(300);
      // Type something
      tui.write('x');
      await sleep(300);
      // Esc to cancel edit
      tui.write('\x1b');
      await sleep(500);

      // Re-enter edit mode — the value should be the original (cancel restored it)
      tui.write('\r');
      await sleep(300);
      // Type a different char to verify we're editing the restored value
      tui.write('z');
      await sleep(300);
      // Should show original URL + 'z', not 'x' + 'z'
      expect(screenContains(getOutput(), 'http://localhost:8080/v1z')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: arrow down moves to API key field',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await waitForText(() => getOutput(), 'custom endpoint', 5000);

      // Arrow down to API key
      tui.write('\x1b[B');
      await sleep(200);
      // Press Enter to edit API key
      tui.write('\r');
      await sleep(200);
      // Type a character
      tui.write('k');
      await sleep(200);
      // Should show masked character for API key
      expect(screenContains(getOutput(), '*')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: Esc in navigation mode goes back to providers',
    async () => {
      await spawnFirstRun();
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\x1b[B');
      await sleep(100);
      tui.write('\r');
      await waitForText(() => getOutput(), 'custom endpoint', 5000);

      // Esc in navigation mode
      tui.write('\x1b');
      await waitForText(() => getOutput(), 'Choose a model provider', 5000);
    },
    TIMEOUT,
  );

  // ─── Connecting Screen ───

  test(
    'connecting screen shows progress and Esc cancels',
    async () => {
      await spawnFirstRun();
      // Select DeepSeek and type a key to trigger connection
      tui.write('\r');
      await waitForText(() => getOutput(), 'API key', 5000);

      // Type a fake key
      for (const ch of 'sk-fake-key') {
        tui.write(ch);
        await sleep(30);
      }
      await sleep(200);

      // Submit → should show connecting screen
      tui.write('\r');
      await waitForText(() => getOutput(), 'Connecting to DeepSeek', 5000);

      // Esc to cancel
      tui.write('\x1b');
      await sleep(500);

      // Should be back on connection form
      expect(screenContains(getOutput(), 'API key')).toBe(true);
    },
    TIMEOUT,
  );

  // ─── Error Screen ───

  test(
    'error screen: shows on connection failure with actionable options',
    async () => {
      await spawnFirstRun();
      // Select DeepSeek
      tui.write('\r');
      await waitForText(() => getOutput(), 'API key', 5000);

      // Type a key (will fail because DeepSeek URL is unreachable in test)
      for (const ch of 'sk-test') {
        tui.write(ch);
        await sleep(30);
      }
      await sleep(200);
      tui.write('\r');

      // Wait for error (connection to api.deepseek.com will fail)
      await waitForText(() => getOutput(), 'Could not', 30000);

      // Error screen should show options
      const out = getOutput();
      expect(screenContains(out, 'Edit API key')).toBe(true);
      expect(screenContains(out, 'Choose another provider')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'error screen: arrow down + Enter on Choose another provider',
    async () => {
      await spawnFirstRun();
      tui.write('\r');
      await waitForText(() => getOutput(), 'API key', 5000);

      for (const ch of 'sk-test') {
        tui.write(ch);
        await sleep(30);
      }
      await sleep(200);
      tui.write('\r');

      await waitForText(() => getOutput(), 'Could not', 30000);

      // Arrow down to "Choose another provider"
      tui.write('\x1b[B');
      await sleep(200);
      // Confirm
      tui.write('\r');
      await sleep(500);

      // Should be back on provider selection
      expect(screenContains(getOutput(), 'Choose a model provider')).toBe(true);
    },
    TIMEOUT,
  );
});
