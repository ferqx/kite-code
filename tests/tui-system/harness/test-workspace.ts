/**
 * Test Workspace — temporary isolated environment for PTY system tests.
 *
 * Each PTY test gets its own:
 * - Temp HOME directory with minimal kite-code.jsonc config
 * - Temp workspace directory (for file operations)
 * - Temp checkpoint database path (isolated SQLite)
 *
 * Reuses patterns from tests/tui-integration/render-tui.tsx.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestWorkspace {
  /** Temp HOME directory */
  home: string;
  /** Temp workspace directory */
  workspace: string;
  /** Path to kite-code.jsonc config */
  configPath: string;
  /** Checkpoint DB directory */
  checkpointDir: string;
  /** Environment variables to pass to child process */
  env: Record<string, string>;
  /** Remove all temp directories */
  cleanup(): void;
}

/**
 * Create a fully isolated test environment.
 *
 * Creates:
 * - <tmp>/kite-code-e2e-<random>/.kite-code/kite-code.jsonc
 * - <tmp>/kite-code-ws-<random>/ (workspace)
 *
 * The returned `env` object should be spread into the child process's env.
 */
export function createTestWorkspace(opts?: {
  files?: Record<string, string>; // path → content, created in workspace
  workspaceFiles?: Record<string, string>;
}): TestWorkspace {
  const tempHome = mkdtempSync(join(tmpdir(), 'kite-code-e2e-'));
  const kiteCodeDir = join(tempHome, '.kite-code');
  mkdirSync(kiteCodeDir, { recursive: true });

  // Minimal config pointing to a fake DeepSeek provider.
  // In PTY tests, the model will be overridden by the mock model server
  // or env-var-injected mock model.
  const config = {
    provider: {
      deepseek: {
        type: 'deepseek' as const,
        apiKey: 'test-key',
        baseURL: 'https://test.api.example.com',
      },
    },
    model: {
      default: { provider: 'deepseek' as const, name: 'deepseek-v4-flash' },
    },
  };
  writeFileSync(join(kiteCodeDir, 'kite-code.jsonc'), JSON.stringify(config, null, 2));

  const checkpointDir = join(tempHome, 'checkpoints');
  mkdirSync(checkpointDir, { recursive: true });

  const ws = mkdtempSync(join(tmpdir(), 'kite-code-ws-'));
  const files = opts?.files ?? opts?.workspaceFiles;
  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(ws, relPath);
      const parent = fullPath.replace(/[/\\][^/\\]+$/, '');
      mkdirSync(parent, { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
  }

  const env: Record<string, string> = {
    HOME: tempHome,
    KITE_CODE_HOME: tempHome,
    // Override checkpoint path to use temp dir
    // (the TUI reads this via defaultCheckpointPath() which uses KITE_CODE_HOME)
  };

  const configPath = join(kiteCodeDir, 'kite-code.jsonc');

  const cleanup = () => {
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  return { home: tempHome, workspace: ws, configPath, checkpointDir, env, cleanup };
}
