/**
 * First-run / setup wizard comprehensive PTY system tests.
 *
 * Covers: provider selection, API key form, custom endpoint form,
 * connection flow, error recovery, manual model entry, and full success path.
 * Config is fully isolated via KITE_CODE_HOME — user-level files are never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, typeMaskedText, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForAnyText,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60000;
const DEFAULT_CUSTOM_ENDPOINT = 'http://localhost:8080/v1';

describe('first-run — comprehensive flow', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  function getOutput(): string {
    return stripAnsi(tui.viewport());
  }

  function getOutputSinceLastAction(): string {
    return stripAnsi(tui.outputSinceLastAction());
  }

  beforeEach(() => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        provider: {
          deepseek: {
            type: 'deepseek' as const,
            apiKey: '',
            baseURL: server.baseURL,
          },
        },
      },
    });
    workspace.env.CI = 'true';
    workspace.env.DEEPSEEK_API_KEY = '';
    workspace.env.OPENAI_API_KEY = '';
  });

  afterEach(async () => {
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
    await waitForText(() => getOutput(), 'Setup 1 of 2', 15000);
    await waitForText(() => getOutput(), '› DeepSeek', 15000);
    await waitForOutputQuiescence(() => getOutputSinceLastAction());
    tui.setRawMode(true);
    await tui.settleScreen();
  }

  async function openDeepSeekForm(): Promise<void> {
    await spawnFirstRun();
    const selectMark = tui.markOutput();
    tui.write('\r');
    await waitForText(() => getOutput(), 'Connect to DeepSeek', 5000);
    await waitForText(() => getOutput(), 'API key', 5000);
    await waitForOutputQuiescence(() => tui.outputSince(selectMark));
  }

  async function openCustomEndpointForm(): Promise<void> {
    await spawnFirstRun();
    tui.write('\x1b[B');
    await waitForText(() => getOutputSinceLastAction(), '› OpenAI', 5000);
    tui.write('\x1b[B');
    await waitForText(() => getOutputSinceLastAction(), '› Custom endpoint', 5000);
    tui.write('\r');
    await waitForText(() => getOutputSinceLastAction(), 'Connect to a custom endpoint', 5000);
  }

  async function connectCustomEndpoint(baseURL: string): Promise<void> {
    await openCustomEndpointForm();

    tui.write('\r');
    await waitForText(() => getOutputSinceLastAction(), '█', 5000);
    await clearInput(tui, Array.from(DEFAULT_CUSTOM_ENDPOINT).length, { backspace: 'ascii' });
    const editMark = tui.markOutput();
    await typeText(tui, baseURL);
    await waitForOutputQuiescence(() => tui.outputSince(editMark));
    expect(screenContains(tui.viewport(), baseURL)).toBe(true);
    tui.write('\r');
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
      await waitForText(() => getOutputSinceLastAction(), '› OpenAI', 5000);
      // OpenAI should now be highlighted (we can't easily check highlight in stripped output,
      // but we can verify by selecting it)
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), 'Connect to OpenAI', 5000);
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
      await openDeepSeekForm();
      expect(screenContains(getOutput(), 'API key')).toBe(true);
      expect(screenContains(getOutput(), 'Setup 2 of 2')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: empty key + Enter stays on form',
    async () => {
      await openDeepSeekForm();
      tui.write('\r'); // Enter with empty key
      await waitForText(() => getOutputSinceLastAction(), 'API key cannot be empty', 5000);
      // Should still be on the form
      expect(screenContains(getOutput(), 'Connect to DeepSeek')).toBe(true);
      expect(screenContains(getOutput(), 'API key')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: Esc returns to provider selection',
    async () => {
      await openDeepSeekForm();
      tui.write('\x1b'); // Esc
      await waitForText(() => getOutputSinceLastAction(), 'Choose a model provider', 5000);
      expect(screenContains(getOutput(), 'Setup 1 of 2')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'DeepSeek: typing key shows masked characters',
    async () => {
      await openDeepSeekForm();
      await typeMaskedText(tui, 'sk-test', 50);
      await waitForText(() => getOutputSinceLastAction(), '*******', 5000);
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
      await openCustomEndpointForm();
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
      await openCustomEndpointForm();

      // Press Enter to edit Base URL (default focus is baseURL)
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), '█', 5000);

      await clearInput(tui, Array.from(DEFAULT_CUSTOM_ENDPOINT).length, { backspace: 'ascii' });

      // Type a short test string
      await typeText(tui, 'http://x.co', 20);

      // Verify the typed text appears
      expect(screenContains(getOutput(), 'http://x.co')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: Esc in edit mode cancels edit and restores value',
    async () => {
      await openCustomEndpointForm();

      // Enter edit mode
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), '█', 5000);
      // Type something
      tui.write('x');
      await waitForText(() => getOutputSinceLastAction(), 'http://localhost:8080/v1x', 5000);
      // Esc to cancel edit
      tui.write('\x1b');
      await waitForText(() => getOutputSinceLastAction(), 'http://localhost:8080/v1', 5000);

      // Re-enter edit mode — the value should be the original (cancel restored it)
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), '█', 5000);
      // Type a different char to verify we're editing the restored value
      tui.write('z');
      await waitForText(() => getOutputSinceLastAction(), 'http://localhost:8080/v1z', 5000);
      // Should show original URL + 'z', not 'x' + 'z'
      expect(screenContains(getOutput(), 'http://localhost:8080/v1z')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: arrow down moves to API key field',
    async () => {
      await openCustomEndpointForm();

      // Arrow down to API key
      tui.write('\x1b[B');
      await waitForText(() => getOutputSinceLastAction(), '› API key', 5000);
      // Press Enter to edit API key
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), '█', 5000);
      // Type a character
      await typeMaskedText(tui, 'k');
      await waitForText(() => getOutputSinceLastAction(), '*', 5000);
      // Should show masked character for API key
      expect(screenContains(getOutput(), '*')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: Esc in navigation mode goes back to providers',
    async () => {
      await openCustomEndpointForm();

      // Esc in navigation mode
      tui.write('\x1b');
      await waitForText(() => getOutputSinceLastAction(), 'Choose a model provider', 5000);
    },
    TIMEOUT,
  );

  // ─── Connecting Screen ───

  test(
    'connecting screen uses the local model fixture and Esc cancels',
    async () => {
      server.setModelsResponse({ delay: 5000 });
      await connectCustomEndpoint(server.baseURL);
      await waitForText(() => getOutputSinceLastAction(), 'Connecting to Custom endpoint', 5000);

      tui.write('\x1b');
      await waitForText(() => getOutputSinceLastAction(), 'Connect to a custom endpoint', 5000);
      expect(screenContains(tui.viewport(), 'Base URL')).toBe(true);
      server.setModelsResponse({});
    },
    TIMEOUT,
  );

  // ─── Error Screen ───

  test(
    'error screen: local incompatible response shows actionable options',
    async () => {
      server.setModelsResponse({ status: 500 });
      await connectCustomEndpoint(server.baseURL);
      await waitForText(() => getOutputSinceLastAction(), 'The endpoint is reachable', 30000);

      // Error screen should show options
      const out = getOutput();
      expect(screenContains(out, 'Enter a model name')).toBe(true);
      expect(screenContains(out, 'Edit connection settings')).toBe(true);
      expect(screenContains(out, 'Choose another provider')).toBe(true);
      server.setModelsResponse({});
    },
    TIMEOUT,
  );

  test(
    'error screen: arrow down + Enter on Choose another provider',
    async () => {
      server.setModelsResponse({ status: 500 });
      await connectCustomEndpoint(server.baseURL);
      await waitForText(() => getOutputSinceLastAction(), 'The endpoint is reachable', 30000);

      // Arrow down to "Choose another provider"
      tui.write('\x1b[B');
      await waitForText(() => getOutputSinceLastAction(), '› Edit connection settings', 5000);
      tui.write('\x1b[B');
      await waitForText(() => getOutputSinceLastAction(), '› Choose another provider', 5000);
      // Confirm
      tui.write('\r');
      await waitForText(() => getOutputSinceLastAction(), 'Choose a model provider', 5000);

      // Should be back on provider selection
      expect(screenContains(tui.viewport(), 'Choose a model provider')).toBe(true);
      server.setModelsResponse({});
    },
    TIMEOUT,
  );

  test(
    'custom endpoint: local model discovery saves the full list and completes setup',
    async () => {
      server.setModelsResponse({ models: ['local-model-a', 'local-model-b'] });
      const modelRequestBaseline = server.getModelRequests().length;
      await connectCustomEndpoint(server.baseURL);

      const terminalReceipt = await waitForAnyText(
        () => getOutputSinceLastAction(),
        ['local-model-a', 'The endpoint is reachable', 'The API key was rejected'],
        30000,
      );
      if (!screenContains(terminalReceipt, 'local-model-a')) {
        expect(screenContains(getOutput(), 'The API key was rejected')).toBe(true);
        tui.write('\r');
        await waitForText(() => getOutputSinceLastAction(), 'Connect to a custom endpoint', 5000);
        if (screenContains(tui.viewport(), '█')) {
          tui.write('\x1b');
          await waitForText(() => getOutputSinceLastAction(), '› Base URL', 5000);
        }
        tui.write('\x1b[B');
        await waitForText(() => getOutputSinceLastAction(), '› API key', 5000);
        tui.write('\r');
        await waitForText(() => getOutputSinceLastAction(), '█', 5000);
        const keyMark = tui.markOutput();
        await typeMaskedText(tui, 'local-key');
        await waitForOutputQuiescence(() => tui.outputSince(keyMark));
        tui.write('\r');
        await waitForText(() => getOutputSinceLastAction(), 'local-model-a', 30000);
      }
      const terminalOutput = getOutput();
      expect(
        screenContains(terminalOutput, 'local-model-a'),
        `model requests: ${server.getModelRequests().join(', ')}`,
      ).toBe(true);
      expect(screenContains(tui.viewport(), '❯')).toBe(true);

      const savedConfig = readFileSync(workspace.configPath, 'utf8');
      expect(savedConfig).toContain('local-model-a');
      expect(savedConfig).toContain('local-model-b');
      expect(savedConfig).toContain(server.baseURL);
      const modelRequests = server.getModelRequests().slice(modelRequestBaseline);
      expect(modelRequests.length).toBeGreaterThanOrEqual(2);
      expect(new Set(modelRequests)).toEqual(new Set([`${server.baseURL}/models`]));
    },
    TIMEOUT,
  );
});
