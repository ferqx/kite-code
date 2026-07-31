/**
 * Test Workspace — temporary isolated environment for PTY system tests.
 *
 * Each PTY test gets its own:
 * - Temp HOME directory with minimal kite-code.jsonc config
 * - Temp workspace directory (for file operations)
 * - Temp checkpoint database path (isolated SQLite)
 *
 * Reuses the temp-home isolation pattern previously used by the old TUI harness.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStore, runtimeStorePathFor } from '@/core/runtime/store';

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
  /** Additional config fields merged into generated test config */
  configOverrides?: Record<string, unknown>;
  /** Optional project-only overrides; defaults to configOverrides for compatibility. */
  projectConfigOverrides?: Record<string, unknown>;
  /** true 时 spawnTui 不预写信任记录，workspace trust 门禁会在启动时触发 */
  enforceWorkspaceTrust?: boolean;
  /** Remove all temp directories */
  cleanup(): void;
}

/** Read the durable Runtime session identities without relying on terminal scrollback. */
export function persistedSessionIds(workspace: Pick<TestWorkspace, 'home'>): string[] {
  const checkpointPath = join(workspace.home, '.kite-code', 'checkpoints.sqlite');
  const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
  try {
    return store
      .listSessions()
      .map((session) => session.threadId)
      .sort();
  } finally {
    store.close();
  }
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
  configOverrides?: Record<string, unknown>;
  projectConfigOverrides?: Record<string, unknown>;
  projectMcpServers?: Record<string, unknown>;
  /**
   * 默认由 spawnTui 向临时信任存储预写一条 source:'test' 记录，启动目录按
   * 生产环境的"已信任"快速路径放行，避免每个 PTY 场景卡在启动授权界面。
   * 设为 true 时不预写，门禁在启动时触发，用于验证门禁本身的场景。
   * 注意：不使用环境变量旁路——Bun 会自动注入 `<cwd>/.env*`，env 开关可被
   * workspace 内文件伪造（见 docs/active/workspace-trust.md）。
   */
  enforceWorkspaceTrust?: boolean;
}): TestWorkspace {
  const tempHome = mkdtempSync(join(tmpdir(), 'kite-code-e2e-'));
  const kiteCodeDir = join(tempHome, '.kite-code');
  mkdirSync(kiteCodeDir, { recursive: true });

  // Minimal config pointing to a fake DeepSeek provider.
  // In PTY tests, the model will be overridden by the mock model server
  // or env-var-injected mock model.
  const { mcpServers: userMcpServers, ...configOverrides } = opts?.configOverrides ?? {};
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
    ...configOverrides,
  };
  writeFileSync(join(kiteCodeDir, 'kite-code.jsonc'), JSON.stringify(config, null, 2));
  if (userMcpServers && typeof userMcpServers === 'object') {
    writeFileSync(
      join(kiteCodeDir, 'mcp.json'),
      `${JSON.stringify({ mcpServers: userMcpServers }, null, 2)}\n`,
      'utf-8',
    );
  }

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
  if (opts?.projectMcpServers) {
    const projectKiteCodeDir = join(ws, '.kite-code');
    mkdirSync(projectKiteCodeDir, { recursive: true });
    writeFileSync(
      join(projectKiteCodeDir, 'mcp.json'),
      `${JSON.stringify({ mcpServers: opts.projectMcpServers }, null, 2)}\n`,
      'utf-8',
    );
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

  return {
    home: tempHome,
    workspace: ws,
    configPath,
    checkpointDir,
    env,
    configOverrides: opts?.configOverrides,
    projectConfigOverrides: opts?.projectConfigOverrides,
    enforceWorkspaceTrust: opts?.enforceWorkspaceTrust ?? false,
    cleanup,
  };
}
