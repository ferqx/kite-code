import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAppSandboxExecutorV1 } from '@/app/sandbox/composition';
import type { ExecutionBoundaryV1, ExecutionCapabilitySurfaceV1 } from '@/core/sandbox/types';

const shellSurface: ExecutionCapabilitySurfaceV1 = {
  inProcessReadOnlyTools: null,
  network: false,
  process: true,
  write: true,
  workspaceWrite: true,
  shell: true,
  skillChild: false,
  localStdioMcp: false,
};

function boundary(workspace: string, networkMode: 'off' | 'allowlist'): ExecutionBoundaryV1 {
  return {
    filesystemScope: 'workspace_write',
    workspaceRoot: workspace,
    networkMode,
    networkAllowlist: networkMode === 'allowlist' ? ['api.example.com'] : [],
    allowLocalAndPrivateNetwork: false,
    protectedPathPolicy: 'deny',
    maxProcessTreeSizePerShellInvocation: 32,
    sandboxRequired: true,
    sandboxUnavailable: 'fail',
  };
}

describe('App sandbox composition', () => {
  test('preserves the explicit development sandbox override without a release boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'development-override');
      const executor = composeAppSandboxExecutorV1({
        entrypoint: 'foreground_cli',
        workspace,
        config: { sandbox: { enabled: true } },
        sandboxEnabled: false,
      });
      const result = await executor({
        workspace,
        command: "bun -e \"require('node:fs').writeFileSync('development-override','explicit')\"",
      });
      expect(result.ok).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('fails closed instead of widening an unenforceable descendant allowlist', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const marker = join(workspace, 'must-not-exist');
      const executor = composeAppSandboxExecutorV1({
        entrypoint: 'tui',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'allowlist'),
          executionCapabilitySurface: shellSurface,
        },
      });
      const result = await executor({
        workspace,
        command: "bun -e \"require('node:fs').writeFileSync('must-not-exist','bypass')\"",
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('fails closed when the sealed surface does not admit Shell', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const executor = composeAppSandboxExecutorV1({
        entrypoint: 'foreground_cli',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'off'),
          executionCapabilitySurface: { ...shellSurface, process: false, shell: false },
        },
      });
      const result = await executor({ workspace, command: 'printf bypass' });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('does not let the development sandbox override disable a release boundary', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kite-app-sandbox-'));
    try {
      const executor = composeAppSandboxExecutorV1({
        entrypoint: 'foreground_cli',
        workspace,
        config: {
          sandbox: { enabled: true },
          executionBoundary: boundary(workspace, 'off'),
          executionCapabilitySurface: shellSurface,
        },
        sandboxEnabled: false,
      });
      const result = await executor({ workspace, command: 'printf bypass' });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('refusing unsandboxed shell execution');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
