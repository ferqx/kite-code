/**
 * First-run PTY boundaries.
 *
 * Screen-local provider/form navigation is covered by tests/first-run-ui.test.tsx.
 * This file keeps the production-flow boundaries that require a real TUI, local
 * HTTP model discovery, cancellation, and persisted configuration.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cleanupTuiSystemFixtures } from '../harness/fixture-lifecycle';
import { createMockModelServer } from '../harness/fixtures';
import { clearInput, submitCurrentInput, typeMaskedText, typeText } from '../harness/input-helpers';
import { type PtyProcess, spawnReadyTui } from '../harness/pty-process';
import {
  screenContains,
  stripAnsi,
  waitForCondition,
  waitForOutputQuiescence,
  waitForText,
} from '../harness/terminal-screen';
import { createTestWorkspace } from '../harness/test-workspace';

const TIMEOUT = 60_000;
const DEFAULT_CUSTOM_ENDPOINT = 'http://localhost:8080/v1';

describe('first-run — connection boundaries', () => {
  let tui: PtyProcess;
  let server: ReturnType<typeof createMockModelServer>;
  let workspace: ReturnType<typeof createTestWorkspace>;

  function output(): string {
    return stripAnsi(tui.viewport());
  }

  beforeEach(() => {
    server = createMockModelServer();
    workspace = createTestWorkspace({
      configOverrides: {
        language: 'en-US',
        sandbox: { enabled: false },
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
    await cleanupTuiSystemFixtures({ tuis: [tui], mockServers: [server], workspaces: [workspace] });
  });

  async function openCustomEndpointForm(): Promise<void> {
    tui = await spawnReadyTui({
      cols: 100,
      rows: 40,
      mockServer: server,
      workspace,
      noPreConfig: true,
      readiness: 'first-run-provider',
    });
    await waitForText(() => output(), '› DeepSeek', 5_000);
    tui.write('\x1b[B');
    await waitForText(() => output(), '› OpenAI', 5_000);
    tui.write('\x1b[B');
    await waitForText(() => output(), '› Custom endpoint', 5_000);
    tui.write('\r');
    await waitForText(() => output(), 'Connect to a custom endpoint', 5_000);
  }

  async function connectCustomEndpoint(baseURL: string): Promise<void> {
    await openCustomEndpointForm();
    tui.write('\r');
    await waitForText(() => output(), '█', 5_000);
    await clearInput(tui, Array.from(DEFAULT_CUSTOM_ENDPOINT).length, { backspace: 'ascii' });
    const editMark = tui.markOutput();
    await typeText(tui, baseURL);
    await waitForOutputQuiescence(() => tui.outputSince(editMark));
    expect(screenContains(tui.viewport(), baseURL)).toBe(true);
    await submitCurrentInput(tui);
  }

  test(
    'cancels a pending local model-discovery request and restores the connection form',
    async () => {
      server.setModelsResponse({ delay: 5_000 });
      await connectCustomEndpoint(server.baseURL);
      await waitForText(() => output(), 'Connecting to Custom endpoint', 5_000);

      tui.write('\x1b');
      await waitForText(() => output(), 'Connect to a custom endpoint', 5_000);
      expect(screenContains(tui.viewport(), 'Base URL')).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'routes an incompatible local model list back to provider selection',
    async () => {
      server.setModelsResponse({ status: 500 });
      await connectCustomEndpoint(server.baseURL);
      await waitForText(() => output(), 'The endpoint is reachable', 30_000);

      tui.write('\x1b[B');
      await waitForText(() => output(), '› Edit connection settings', 5_000);
      tui.write('\x1b[B');
      await waitForText(() => output(), '› Choose another provider', 5_000);
      tui.write('\r');
      await waitForText(() => output(), 'Choose a model provider', 5_000);
    },
    TIMEOUT,
  );

  test(
    'discovers local models, persists the full list, and completes setup',
    async () => {
      server.setModelsResponse({ models: ['local-model-a', 'local-model-b'] });
      const modelRequestBaseline = server.getModelRequests().length;
      await connectCustomEndpoint(server.baseURL);

      await waitForText(() => output(), 'The API key was rejected.', 30_000);
      await waitForText(() => output(), '› Edit connection settings', 5_000);
      tui.write('\r');
      await waitForText(() => output(), '█', 5_000);
      tui.write('\x1b');
      await waitForCondition(
        () => !output().includes('█') && screenContains(output(), '› Base URL'),
        'restored custom endpoint navigation after cancelling automatic base URL edit',
        5_000,
      );
      tui.write('\x1b[B');
      await waitForText(() => output(), '› API key', 5_000);
      tui.write('\r');
      await waitForText(() => output(), '█', 5_000);
      await typeMaskedText(tui, 'local-key');
      await waitForText(() => output(), '*********', 5_000);
      await submitCurrentInput(tui, {
        acceptWhen: (viewport) =>
          screenContains(viewport, 'Connecting to Custom endpoint') ||
          screenContains(viewport, 'local-model-a'),
      });
      await waitForCondition(
        () => {
          const viewport = tui.viewport();
          return screenContains(viewport, 'local-model-a') && screenContains(viewport, '❯');
        },
        'completed setup with the selected local model and an interactive prompt',
        30_000,
      );

      expect(screenContains(tui.viewport(), 'local-model-a')).toBe(true);
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
