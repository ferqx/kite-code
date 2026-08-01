import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AgentConfig } from '@/core/config';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import { McpConnectionManager } from '@/core/mcp/manager';
import { createProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import { readFileSpec } from '@/core/tools/registry/builtins/read-file';
import { searchContentSpec } from '@/core/tools/registry/builtins/search-content';
import { writeFileSpec } from '@/core/tools/registry/builtins/write-file';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';

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

describe('protected-path policy V1', () => {
  test('returns canonical path and preserves read/write operation semantics', () => {
    const workspace = temporaryDirectory('openpx-protected-operation-');
    mkdirSync(join(workspace, 'src'));
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    const read = evaluator.evaluate({ path: 'src/file.ts', operation: 'read' });
    const write = evaluator.evaluate({ path: 'src/file.ts', operation: 'write' });

    expect(read).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_workspace_path',
      relativePath: 'src/file.ts',
      operation: 'read',
    });
    expect(write).toMatchObject({ outcome: 'allow', operation: 'write' });
    expect(read.canonicalPath).toBe(canonicalPathForComparison(join(workspace, 'src', 'file.ts')));
  });

  test('denies Git, Agent/MCP config, credentials, shell profiles, and workspace-external paths', () => {
    const workspace = temporaryDirectory('openpx-protected-rules-');
    const outside = temporaryDirectory('openpx-protected-outside-');
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    for (const path of [
      '.git/config',
      '.kite-code/kite-code.jsonc',
      '.mcp.json',
      '.env',
      '.ssh/id_ed25519',
      '.zshrc',
    ]) {
      expect(evaluator.evaluate({ path, operation: 'read' }).outcome).toBe('deny');
      expect(evaluator.evaluate({ path, operation: 'write' }).outcome).toBe('deny');
    }
    expect(evaluator.evaluate({ path: outside, operation: 'read' })).toMatchObject({
      outcome: 'deny',
      reason: 'outside_workspace',
      relativePath: null,
    });
  });

  test('canonicalizes an existing symlink ancestor before deciding', () => {
    const workspace = temporaryDirectory('openpx-protected-symlink-workspace-');
    const outside = temporaryDirectory('openpx-protected-symlink-outside-');
    symlinkSync(outside, join(workspace, 'escape'));
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    const decision = evaluator.evaluate({ path: 'escape/new.txt', operation: 'write' });
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'outside_workspace' });
    expect(decision.canonicalPath).toBe(canonicalPathForComparison(join(outside, 'new.txt')));
  });

  test('preserves a protected lexical identity when a symlink points inward', () => {
    const workspace = temporaryDirectory('openpx-protected-inward-symlink-');
    mkdirSync(join(workspace, 'ordinary'));
    writeFileSync(join(workspace, 'ordinary', 'config'), 'ordinary');
    writeFileSync(join(workspace, 'public.txt'), 'public');
    symlinkSync('ordinary', join(workspace, '.git'));
    symlinkSync('public.txt', join(workspace, '.env'));
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'read' })).toMatchObject({
      outcome: 'deny',
      reason: 'protected_directory',
      lexicalRelativePath: '.git/config',
      relativePath: 'ordinary/config',
    });
    expect(evaluator.evaluate({ path: '.env', operation: 'read' })).toMatchObject({
      outcome: 'deny',
      reason: 'protected_file',
      lexicalRelativePath: '.env',
      relativePath: 'public.txt',
    });
  });

  test('evaluates deny roots before a tighter allowlist', () => {
    const workspace = temporaryDirectory('openpx-protected-deny-wins-');
    mkdirSync(join(workspace, '.git'));
    const evaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
      allowedPaths: ['.git'],
    });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'read' })).toMatchObject({
      outcome: 'deny',
      reason: 'protected_directory',
      matchedRule: '.git',
    });
  });

  test('unions additional deny roots and keeps prompt as a non-allow outcome', () => {
    const workspace = temporaryDirectory('openpx-protected-union-');
    mkdirSync(join(workspace, 'private'));
    const deny = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
      additionalDeniedPaths: ['private'],
    });
    const prompt = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'prompt' });

    expect(deny.evaluate({ path: 'private/data.txt', operation: 'read' }).reason).toBe(
      'additional_deny',
    );
    expect(prompt.evaluate({ path: '.env', operation: 'read' }).outcome).toBe('prompt');
    expect(prompt.evaluate({ path: 'bad\0path', operation: 'write' })).toMatchObject({
      outcome: 'prompt',
      reason: 'invalid_path',
      canonicalPath: null,
    });
  });
});

describe('protected-path Registry and Harness integration', () => {
  test('Registry rejects protected reads and writes before execute', async () => {
    const workspace = temporaryDirectory('openpx-protected-registry-');
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'config'), 'secret');
    writeFileSync(join(workspace, '.env'), 'keep');
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
    });

    const read = await dispatchRegisteredTool(
      readFileSpec,
      { path: '.git/config' },
      { workspace, protectedPathEvaluator },
    );
    const write = await dispatchRegisteredTool(
      writeFileSpec,
      { path: '.env', content: 'changed' },
      { workspace, protectedPathEvaluator },
    );

    expect(read).toMatchObject({ dispatched: false });
    expect(write).toMatchObject({ dispatched: false });
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('keep');
  });

  test('Registry rejects an explicit protected search root even when it aliases inward', async () => {
    const workspace = temporaryDirectory('openpx-protected-search-alias-');
    mkdirSync(join(workspace, 'ordinary'));
    writeFileSync(join(workspace, 'ordinary', 'config'), 'needle');
    symlinkSync('ordinary', join(workspace, '.git'));
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
    });

    const result = await dispatchRegisteredTool(
      searchContentSpec,
      { pattern: 'needle', path: '.git' },
      { workspace, protectedPathEvaluator },
    );

    expect(result).toMatchObject({ dispatched: false });
  });

  test('Harness rejects before write pre-image capture', async () => {
    const workspace = temporaryDirectory('openpx-protected-harness-');
    writeFileSync(join(workspace, '.env'), 'keep');
    const parsed = toolRequestFromCall(
      { id: 'protected-write', name: 'write_file', args: { path: '.env', content: 'changed' } },
      workspace,
    );
    if (!parsed?.ok) throw new Error('write_file request must parse');
    let preimages = 0;

    const result = await runApprovedTool({
      workspace,
      request: parsed.request,
      taskConfig: productionBoundaryConfig(workspace),
      recordFilePreimage: () => {
        preimages++;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.stderr).toContain('protected-path policy');
    expect(preimages).toBe(0);
    expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('keep');
  });

  test('Harness rechecks write/edit paths after the asynchronous pre-dispatch hook', async () => {
    for (const tool of ['write_file', 'edit_file'] as const) {
      const workspace = temporaryDirectory(`openpx-protected-hook-${tool}-`);
      writeFileSync(join(workspace, 'public.txt'), 'PUBLIC');
      writeFileSync(join(workspace, '.env'), 'TOP_SECRET');
      symlinkSync('public.txt', join(workspace, 'target'));
      const args =
        tool === 'write_file'
          ? { path: 'target', content: 'changed' }
          : { path: 'target', old_string: 'PUBLIC', new_string: 'changed' };
      const parsed = toolRequestFromCall({ id: `hook-${tool}`, name: tool, args }, workspace);
      if (!parsed?.ok) throw new Error(`${tool} request must parse`);
      let preimages = 0;

      const result = await runApprovedTool({
        workspace,
        request: parsed.request,
        taskConfig: productionBoundaryConfig(workspace),
        beforeDispatch: async () => {
          unlinkSync(join(workspace, 'target'));
          symlinkSync('.env', join(workspace, 'target'));
        },
        recordFilePreimage: () => {
          preimages++;
        },
      });

      expect(result).toMatchObject({ ok: false, status: 'rejected' });
      expect(result.stderr).toContain('protected-path policy');
      expect(preimages).toBe(0);
      expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('TOP_SECRET');
    }
  });

  test('workspace-wide content search prunes protected descendants', async () => {
    const workspace = temporaryDirectory('openpx-protected-search-');
    mkdirSync(join(workspace, '.kite-code'));
    writeFileSync(join(workspace, 'public.txt'), 'needle public');
    writeFileSync(join(workspace, '.env'), 'needle credential');
    writeFileSync(join(workspace, '.kite-code', 'config.json'), 'needle agent-config');
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
    });

    const result = await dispatchRegisteredTool(
      searchContentSpec,
      { pattern: 'needle', path: '.' },
      { workspace, protectedPathEvaluator },
    );

    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error(result.rejection.error);
    expect(result.output.stdout).toContain('public.txt');
    expect(result.output.stdout).not.toContain('.env');
    expect(result.output.stdout).not.toContain('.kite-code');
    expect(result.output.stdout).not.toContain('credential');
    expect(result.output.stdout).not.toContain('agent-config');
  });

  test('local stdio MCP rejects a protected cwd before transport creation', async () => {
    const workspace = temporaryDirectory('openpx-protected-mcp-');
    mkdirSync(join(workspace, '.kite-code'));
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
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
        return {} as never;
      },
    });

    await expect(
      manager.connect('protected', {
        type: 'stdio',
        command: 'fixture',
        cwd: join(workspace, '.kite-code'),
      }),
    ).rejects.toThrow('protected-path policy');
    expect(transports).toBe(0);
    expect(manager.getServerStates().get('protected')?.health).toBe('disconnected');

    await expect(
      manager.connect('protected-executable', {
        type: 'stdio',
        command: '.git/hooks/server',
        cwd: workspace,
      }),
    ).rejects.toThrow('executable by protected-path policy');
    expect(transports).toBe(0);
  });

  test('local stdio MCP passes the canonical admitted cwd to its transport factory', async () => {
    const workspace = temporaryDirectory('openpx-protected-mcp-canonical-');
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
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
