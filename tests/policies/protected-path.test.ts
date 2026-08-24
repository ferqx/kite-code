import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpConnectionManager } from '@kite/builtin-runtime/mcp';
import {
  canonicalExistingPath,
  canonicalPathForComparison,
  createProtectedPathEvaluator,
  generateSandboxProfile,
  PROTECTED_WORKSPACE_DIRECTORIES_,
  PROTECTED_WORKSPACE_FILE_PREFIXES_,
  PROTECTED_WORKSPACE_FILES_,
} from '@kite/builtin-runtime/sandbox';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentConfig } from '#app/config';
import type { RuntimeJsonValue } from '#runtime-spi';
import { executeTestRuntimeTool } from '../helpers/runtime-model';

const roots: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

function productionBoundaryConfig(workspace: string): AgentConfig {
  return {
    apiKey: '',
    baseURL: 'http://localhost',
    modelName: 'test-model',
    providerName: 'test-provider',
    providerType: 'openai-compatible',
    sandbox: { enabled: true },
    executionBoundary: {
      filesystemScope: 'workspace_write',
      workspaceRoot: workspace,
      networkMode: 'off',
      networkAllowlist: [],
      allowLocalAndPrivateNetwork: false,
      protectedPathPolicy: 'deny',
      maxProcessTreeSizePerShellInvocation: 8,
      sandboxRequired: true,
      sandboxUnavailable: 'fail',
    },
  };
}

function parsedBuiltinRequest(
  workspace: string,
  name: Parameters<typeof executeTestRuntimeTool>[0]['toolName'],
  args: Readonly<Record<string, RuntimeJsonValue>>,
) {
  return { workspace, name, args };
}

describe('protected-path policy V1', () => {
  test('returns canonical path and preserves read/write operation semantics', () => {
    const workspace = temporaryDirectory('openpx-protected-operation-');
    mkdirSync(join(workspace, 'src'));
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    const read = evaluator.evaluate({ path: 'src/file.ts', operation: 'read' });
    const write = evaluator.evaluate({ path: 'src/file.ts', operation: 'write' });

    expect(read).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_read_path',
      relativePath: 'src/file.ts',
      operation: 'read',
    });
    expect(write).toMatchObject({ outcome: 'allow', operation: 'write' });
    expect(read.canonicalPath).toBe(canonicalPathForComparison(join(workspace, 'src', 'file.ts')));
  });

  test('admits every operation inside the canonical Workspace', () => {
    const workspace = temporaryDirectory('openpx-protected-rules-');
    const outside = temporaryDirectory('openpx-protected-outside-');
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    for (const path of [
      '.git/config',
      '.agents/skills/document-before-commit/SKILL.md',
      '.kite-code/kite-code.jsonc',
      '.mcp.json',
      '.env',
      '.env.test',
      '.ssh/id_ed25519',
      '.zshrc',
      '.cshrc',
      '.config/fish/config.fish',
    ]) {
      expect(evaluator.evaluate({ path, operation: 'read' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'write' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'execute' }).outcome).toBe('allow');
    }
    expect(evaluator.evaluate({ path: outside, operation: 'read' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_read_path',
      relativePath: null,
    });
    expect(evaluator.evaluate({ path: outside, operation: 'write' })).toMatchObject({
      outcome: 'prompt',
      reason: 'outside_workspace',
      relativePath: null,
    });
    expect(
      evaluator.evaluate({ path: '~/.ssh/authorized_keys', operation: 'write' }),
    ).toMatchObject({
      outcome: 'prompt',
      reason: 'outside_workspace',
      relativePath: null,
    });
  });

  test('treats a Codex-managed worktree as a complete trusted workspace', () => {
    const host = temporaryDirectory('openpx-managed-host-');
    const workspace = join(host, '.codex', 'worktrees', 'fixture', 'project');
    mkdirSync(workspace, { recursive: true });
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    for (const path of [
      'package.json',
      '.git/config',
      '.env',
      '.ssh/config',
      '.codex/settings.json',
      '.agents/skills/example/SKILL.md',
    ]) {
      expect(evaluator.evaluate({ path, operation: 'read' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'write' }).outcome).toBe('allow');
    }
  });

  test('does not reinterpret Workspace case aliases as protected identities', () => {
    const workspace = temporaryDirectory('openpx-protected-case-alias-');
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    for (const path of [
      '.GIT/config',
      '.Agents/skills/fixture/SKILL.md',
      '.ENV.TEST',
      '.Config/GH/hosts.yml',
      'library/launchagents/fixture.plist',
    ]) {
      expect(evaluator.evaluate({ path, operation: 'read' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'write' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'execute' }).outcome).toBe('allow');
    }
  });

  test('canonicalizes an existing symlink ancestor before deciding', () => {
    const workspace = temporaryDirectory('openpx-protected-symlink-workspace-');
    const outside = temporaryDirectory('openpx-protected-symlink-outside-');
    symlinkSync(
      outside,
      join(workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    const decision = evaluator.evaluate({ path: 'escape/new.txt', operation: 'write' });
    expect(decision).toMatchObject({ outcome: 'prompt', reason: 'outside_workspace' });
    expect(decision.canonicalPath).toBe(canonicalPathForComparison(join(outside, 'new.txt')));
  });

  test('allows protected-looking inward aliases for every operation', () => {
    const workspace = temporaryDirectory('openpx-protected-inward-symlink-');
    mkdirSync(join(workspace, 'ordinary'));
    writeFileSync(join(workspace, 'ordinary', 'config'), 'ordinary');
    writeFileSync(join(workspace, 'public.txt'), 'public');
    symlinkSync(
      join(workspace, 'ordinary'),
      join(workspace, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    if (process.platform !== 'win32') {
      symlinkSync('public.txt', join(workspace, '.env'));
    }
    const evaluator = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'deny' });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'read' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_read_path',
      lexicalRelativePath: '.git/config',
      relativePath: 'ordinary/config',
    });
    expect(evaluator.evaluate({ path: '.git/config', operation: 'write' }).outcome).toBe('allow');
    expect(evaluator.evaluate({ path: '.git/config', operation: 'execute' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_workspace_path',
    });
    if (process.platform !== 'win32') {
      expect(evaluator.evaluate({ path: '.env', operation: 'read' })).toMatchObject({
        outcome: 'allow',
        reason: 'allowed_read_path',
        lexicalRelativePath: '.env',
        relativePath: 'public.txt',
      });
    }
  });

  test('does not let a name-based allowlist narrow the canonical Workspace', () => {
    const workspace = temporaryDirectory('openpx-protected-deny-wins-');
    mkdirSync(join(workspace, '.git'));
    const evaluator = createProtectedPathEvaluator({
      workspaceRoot: workspace,
      mode: 'deny',
      allowedPaths: ['.git'],
    });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'execute' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_workspace_path',
    });
  });

  test('ignores name-based deny roots inside Workspace and still rejects invalid paths', () => {
    const workspace = temporaryDirectory('openpx-protected-union-');
    mkdirSync(join(workspace, 'private'));
    const deny = createProtectedPathEvaluator({
      workspaceRoot: workspace,
      mode: 'deny',
      additionalDeniedPaths: ['private'],
    });
    const prompt = createProtectedPathEvaluator({ workspaceRoot: workspace, mode: 'prompt' });

    expect(deny.evaluate({ path: 'private/data.txt', operation: 'execute' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_workspace_path',
    });
    expect(prompt.evaluate({ path: '.env', operation: 'read' }).outcome).toBe('allow');
    expect(prompt.evaluate({ path: '.env', operation: 'execute' }).outcome).toBe('allow');
    expect(prompt.evaluate({ path: 'bad\0path', operation: 'write' })).toMatchObject({
      outcome: 'prompt',
      reason: 'invalid_path',
      canonicalPath: null,
    });
  });

  test('keeps Workspace identities out of the native Seatbelt deny boundary', () => {
    const workspace = temporaryDirectory('openpx-protected-seatbelt-');
    const profile = generateSandboxProfile(workspace);
    const canonicalWorkspace = canonicalExistingPath(workspace);

    for (const path of [
      ...PROTECTED_WORKSPACE_DIRECTORIES_,
      ...PROTECTED_WORKSPACE_FILES_,
      ...PROTECTED_WORKSPACE_FILE_PREFIXES_,
    ]) {
      const seatbeltPath = resolve(canonicalWorkspace, path)
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"');
      expect(profile).not.toContain(seatbeltPath);
    }
    expect(profile).not.toContain('(deny file-read* file-map-executable file-write*');
  });
});

describe('path-policy Registry and Harness integration', () => {
  test('Harness allows an explicit protected-looking search root when it aliases inward', async () => {
    const workspace = temporaryDirectory('openpx-protected-search-alias-');
    mkdirSync(join(workspace, 'ordinary'));
    writeFileSync(join(workspace, 'ordinary', 'config'), 'needle');
    symlinkSync(
      join(workspace, 'ordinary'),
      join(workspace, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const request = parsedBuiltinRequest(workspace, 'search_content', {
      pattern: 'needle',
      path: '.git',
    });
    const result = await executeTestRuntimeTool({
      workspace: request.workspace,
      toolName: request.name,
      args: request.args,
      execution: {
        taskConfig: productionBoundaryConfig(workspace),
        sandboxAvailable: true,
      },
    });

    expect(result.terminal).toMatchObject({
      type: 'tool.finished',
      result: { ok: true },
    });
    expect(result.result?.stdout).toContain('needle');
  });

  test('App pipeline allows a trusted-workspace protected-looking write and records its preimage', async () => {
    const workspace = temporaryDirectory('openpx-protected-harness-');
    writeFileSync(join(workspace, '.env'), 'keep');
    let preimages = 0;

    const request = parsedBuiltinRequest(workspace, 'write_file', {
      path: '.env',
      content: 'changed',
    });
    const result = await executeTestRuntimeTool({
      workspace: request.workspace,
      toolName: request.name,
      args: request.args,
      execution: {
        taskConfig: productionBoundaryConfig(workspace),
        sandboxAvailable: true,
        recordFilePreimage: () => {
          preimages++;
        },
      },
    });

    // The production filesystem pipeline records one rewind preimage before
    // commit. The removed Harness-only path never exercised that lifecycle.
    expect(preimages).toBe(1);
    expect(result.terminal).toMatchObject({
      type: 'tool.finished',
      result: { ok: true },
    });
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('changed');
  });

  test('production writer fails closed when its protected-path gate is missing', async () => {
    const workspace = temporaryDirectory('openpx-protected-missing-gate-');
    const target = join(workspace, 'ordinary.txt');
    writeFileSync(target, 'keep');
    const taskConfig = {
      ...productionBoundaryConfig(workspace),
      executionBoundary: undefined,
      executionCapabilitySurface: undefined,
      productionExecution: {},
    } as unknown as AgentConfig;

    const request = parsedBuiltinRequest(workspace, 'write_file', {
      path: target,
      content: 'changed',
    });
    const result = await executeTestRuntimeTool({
      workspace: request.workspace,
      toolName: request.name,
      args: request.args,
      execution: { taskConfig, sandboxAvailable: true },
    });

    expect(result.terminal).toMatchObject({ type: 'tool.rejected' });
    if (result.terminal?.type === 'tool.rejected') {
      expect(result.terminal.reason).toContain('protected-path gate is unavailable');
    }
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  test('workspace-wide content search includes protected-looking descendants', async () => {
    const workspace = temporaryDirectory('openpx-protected-search-');
    mkdirSync(join(workspace, '.kite-code'));
    writeFileSync(join(workspace, 'public.txt'), 'needle public');
    writeFileSync(join(workspace, '.env'), 'needle credential');
    writeFileSync(join(workspace, '.kite-code', 'config.json'), 'needle agent-config');
    const request = parsedBuiltinRequest(workspace, 'search_content', {
      pattern: 'needle',
      path: '.',
    });
    const result = await executeTestRuntimeTool({
      workspace: request.workspace,
      toolName: request.name,
      args: request.args,
      execution: {
        taskConfig: productionBoundaryConfig(workspace),
        sandboxAvailable: true,
      },
    });

    expect(result.terminal).toMatchObject({
      type: 'tool.finished',
      result: { ok: true },
    });
    expect(result.result?.stdout).toContain('public.txt');
    expect(result.result?.stdout).toContain('.env');
    expect(result.result?.stdout).toContain('.kite-code');
    expect(result.result?.stdout).toContain('credential');
    expect(result.result?.stdout).toContain('agent-config');
  });

  test('local stdio MCP admits every Workspace cwd and executable', async () => {
    const workspace = temporaryDirectory('openpx-protected-mcp-');
    mkdirSync(join(workspace, '.kite-code'));
    const protectedPathEvaluator = createProtectedPathEvaluator({
      workspaceRoot: workspace,
      mode: 'deny',
    });
    let transports = 0;
    const manager = new McpConnectionManager({
      protectedPathEvaluator,
      createClient: () =>
        ({
          close: async () => {},
        }) as unknown as Client,
      createTransport: () => {
        transports++;
        throw new Error('transport fixture stop');
      },
    });

    await expect(
      manager.connect('protected', {
        type: 'stdio',
        command: 'fixture',
        cwd: join(workspace, '.kite-code'),
      }),
    ).rejects.toThrow('transport fixture stop');
    expect(transports).toBe(1);
    expect(manager.getServerStates().get('protected')?.health).toBe('disconnected');

    await expect(
      manager.connect('protected-executable', {
        type: 'stdio',
        command: '.git/hooks/server',
        cwd: workspace,
      }),
    ).rejects.toThrow('transport fixture stop');
    expect(transports).toBe(2);
  });

  test('local stdio MCP passes the canonical admitted cwd to its transport factory', async () => {
    const workspace = temporaryDirectory('openpx-protected-mcp-canonical-');
    const protectedPathEvaluator = createProtectedPathEvaluator({
      workspaceRoot: workspace,
      mode: 'deny',
    });
    let transportCwd: string | undefined;
    let transportCommand: string | undefined;
    const manager = new McpConnectionManager({
      protectedPathEvaluator,
      createClient: () =>
        ({
          close: async () => {},
        }) as unknown as Client,
      createTransport: (config) => {
        transportCwd = config.cwd;
        transportCommand = config.command;
        throw new Error('transport fixture stop');
      },
    });

    await expect(
      manager.connect('allowed', { type: 'stdio', command: './server', cwd: workspace }),
    ).rejects.toThrow('transport fixture stop');
    expect(transportCwd).toBe(canonicalPathForComparison(workspace));
    expect(transportCommand).toBe(canonicalPathForComparison(join(workspace, 'server')));
  });
});
