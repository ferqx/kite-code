import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import type { AgentConfig } from '@/core/config';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { invokeGovernedTool } from '@/core/harness/tool-runner';
import { McpConnectionManager } from '@/core/mcp/manager';
import {
  createProtectedPathEvaluatorV1,
  PROTECTED_WORKSPACE_DIRECTORIES_V1,
  PROTECTED_WORKSPACE_FILE_PREFIXES_V1,
  PROTECTED_WORKSPACE_FILES_V1,
} from '@/core/policies/protected-path';
import { canonicalExistingPath, generateSandboxProfile } from '@/core/sandbox/profile';
import { canonicalPathForComparison } from '@/core/tools/path-utils';
import { builtinToolSpecs } from '@/core/tools/registry/builtins';
import { editFileSpec } from '@/core/tools/registry/builtins/edit-file';
import { readFileSpec } from '@/core/tools/registry/builtins/read-file';
import { searchContentSpec } from '@/core/tools/registry/builtins/search-content';
import { searchFilesSpec } from '@/core/tools/registry/builtins/search-files';
import { writeFileSpec } from '@/core/tools/registry/builtins/write-file';
import { dispatchRegisteredTool } from '@/core/tools/registry/dispatch';
import { LegacyWorkspaceFilesystemDispatcherV1 } from '../helpers/legacy-workspace-filesystem-dispatcher';

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
      reason: 'allowed_read_path',
      relativePath: 'src/file.ts',
      operation: 'read',
    });
    expect(write).toMatchObject({ outcome: 'allow', operation: 'write' });
    expect(read.canonicalPath).toBe(canonicalPathForComparison(join(workspace, 'src', 'file.ts')));
  });

  test('allows all file reads and trusted-workspace writes while retaining execute protection', () => {
    const workspace = temporaryDirectory('openpx-protected-rules-');
    const outside = temporaryDirectory('openpx-protected-outside-');
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

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
      expect(evaluator.evaluate({ path, operation: 'execute' }).outcome).toBe('deny');
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
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

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

  test('matches protected execute identities conservatively across ASCII case aliases', () => {
    const workspace = temporaryDirectory('openpx-protected-case-alias-');
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    for (const path of [
      '.GIT/config',
      '.Agents/skills/fixture/SKILL.md',
      '.ENV.TEST',
      '.Config/GH/hosts.yml',
      'library/launchagents/fixture.plist',
    ]) {
      expect(evaluator.evaluate({ path, operation: 'read' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'write' }).outcome).toBe('allow');
      expect(evaluator.evaluate({ path, operation: 'execute' }).outcome).toBe('deny');
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
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    const decision = evaluator.evaluate({ path: 'escape/new.txt', operation: 'write' });
    expect(decision).toMatchObject({ outcome: 'prompt', reason: 'outside_workspace' });
    expect(decision.canonicalPath).toBe(canonicalPathForComparison(join(outside, 'new.txt')));
  });

  test('allows protected-looking file aliases while retaining execute denial', () => {
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
    const evaluator = createProtectedPathEvaluatorV1({ workspaceRoot: workspace, mode: 'deny' });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'read' })).toMatchObject({
      outcome: 'allow',
      reason: 'allowed_read_path',
      lexicalRelativePath: '.git/config',
      relativePath: 'ordinary/config',
    });
    expect(evaluator.evaluate({ path: '.git/config', operation: 'write' }).outcome).toBe('allow');
    expect(evaluator.evaluate({ path: '.git/config', operation: 'execute' })).toMatchObject({
      outcome: 'deny',
      reason: 'protected_directory',
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

  test('evaluates deny roots before a tighter allowlist', () => {
    const workspace = temporaryDirectory('openpx-protected-deny-wins-');
    mkdirSync(join(workspace, '.git'));
    const evaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
      allowedPaths: ['.git'],
    });

    expect(evaluator.evaluate({ path: '.git/config', operation: 'execute' })).toMatchObject({
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

    expect(deny.evaluate({ path: 'private/data.txt', operation: 'execute' }).reason).toBe(
      'additional_deny',
    );
    expect(prompt.evaluate({ path: '.env', operation: 'read' }).outcome).toBe('allow');
    expect(prompt.evaluate({ path: '.env', operation: 'execute' }).outcome).toBe('prompt');
    expect(prompt.evaluate({ path: 'bad\0path', operation: 'write' })).toMatchObject({
      outcome: 'prompt',
      reason: 'invalid_path',
      canonicalPath: null,
    });
  });

  test('projects every shared protected rule into the native Seatbelt boundary', () => {
    const workspace = temporaryDirectory('openpx-protected-seatbelt-');
    const profile = generateSandboxProfile(workspace);
    const canonicalWorkspace = canonicalExistingPath(workspace);

    for (const path of [
      ...PROTECTED_WORKSPACE_DIRECTORIES_V1,
      ...PROTECTED_WORKSPACE_FILES_V1,
      ...PROTECTED_WORKSPACE_FILE_PREFIXES_V1,
    ]) {
      const seatbeltPath = resolve(canonicalWorkspace, path)
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"');
      expect(profile).toContain(seatbeltPath);
    }
    expect(profile).toContain('(regex #"');
    expect(profile).toContain('[gG][iI][tT]');
    expect(profile).toContain('[aA][gG][eE][nN][tT][sS]');
    expect(profile).toContain('[eE][nN][vV]');
  });
});

describe('path-policy Registry and Harness integration', () => {
  test('Registry allows reads and writes to protected-looking workspace paths', async () => {
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
      {
        workspace,
        protectedPathEvaluator,
        workspaceFilesystem: new LegacyWorkspaceFilesystemDispatcherV1({ workspace }),
      },
    );
    const write = await dispatchRegisteredTool(
      writeFileSpec,
      { path: '.env', content: 'changed' },
      {
        workspace,
        protectedPathEvaluator,
        workspaceFilesystem: new LegacyWorkspaceFilesystemDispatcherV1({ workspace }),
      },
    );

    expect(read).toMatchObject({ dispatched: true });
    expect(write).toMatchObject({ dispatched: true });
    if (process.platform === 'win32') {
      if (!write.dispatched) throw new Error(write.rejection.error);
      expect(write.output).toMatchObject({ ok: false });
      expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('keep');
    } else {
      expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('changed');
    }
  });

  test('every builtin path-bearing spec declares read/write operations structurally', () => {
    const context = { workspace: '/fixture' };
    expect(readFileSpec.protectedPathAccesses?.({ path: 'read.txt' }, context)).toEqual([
      { path: 'read.txt', operation: 'read' },
    ]);
    expect(
      writeFileSpec.protectedPathAccesses?.({ path: 'write.txt', content: '' }, context),
    ).toEqual([
      { path: 'write.txt', operation: 'read' },
      { path: 'write.txt', operation: 'write' },
    ]);
    expect(
      editFileSpec.protectedPathAccesses?.(
        { path: 'edit.txt', old_string: 'a', new_string: 'b' },
        context,
      ),
    ).toEqual([
      { path: 'edit.txt', operation: 'read' },
      { path: 'edit.txt', operation: 'write' },
    ]);
    expect(searchContentSpec.protectedPathAccesses?.({ pattern: 'x', path: '.' }, context)).toEqual(
      [{ path: '.', operation: 'read' }],
    );
    expect(
      searchFilesSpec.protectedPathAccesses?.({ pattern: '*.ts', path: '.' }, context),
    ).toEqual([{ path: '.', operation: 'read' }]);
  });

  test('ratchets every filesystem builtin through a protected-path hook or closed exception set', () => {
    const internalFilesystemExceptions = [
      { name: 'read_plan', boundary: 'typed immutable Plan Artifact store' },
      { name: 'read_skill_reference', boundary: 'compiled Skill reference allowlist' },
      { name: 'shell_execute', boundary: 'native sandbox profile' },
      { name: 'git_inspect', boundary: 'typed Git broker protected-path evaluator' },
      { name: 'task', boundary: 'delegated child Harness' },
      { name: 'activate_skill', boundary: 'compiled inline/fork adapter' },
    ] as const;
    const filesystemSpecs = builtinToolSpecs.filter(
      (spec) => spec.declaredEffects.filesystem !== 'none',
    );
    const missingHooks = filesystemSpecs
      .filter((spec) => !('protectedPathAccesses' in spec))
      .map((spec) => spec.name)
      .sort();
    const expectedExceptions = internalFilesystemExceptions.map((exception) => exception.name);

    expect(internalFilesystemExceptions.every((exception) => exception.boundary.length > 0)).toBe(
      true,
    );
    expect(missingHooks).toEqual([...expectedExceptions].sort());
    for (const spec of filesystemSpecs) {
      if (expectedExceptions.includes(spec.name as (typeof expectedExceptions)[number])) {
        continue;
      }
      expect(
        'protectedPathAccesses' in spec && typeof spec.protectedPathAccesses === 'function',
      ).toBe(true);
    }

    const modelPathSpecsWithoutHooks = builtinToolSpecs
      .filter((spec) => {
        const schema = z.toJSONSchema(spec.inputSchema) as {
          properties?: Record<string, unknown>;
        };
        return Object.hasOwn(schema.properties ?? {}, 'path');
      })
      .filter((spec) => !('protectedPathAccesses' in spec))
      .map((spec) => spec.name)
      .sort();
    expect(modelPathSpecsWithoutHooks).toEqual(['read_skill_reference']);
  });

  test('Registry allows an explicit protected-looking search root when it aliases inward', async () => {
    const workspace = temporaryDirectory('openpx-protected-search-alias-');
    mkdirSync(join(workspace, 'ordinary'));
    writeFileSync(join(workspace, 'ordinary', 'config'), 'needle');
    symlinkSync(
      join(workspace, 'ordinary'),
      join(workspace, '.git'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
    });

    const result = await dispatchRegisteredTool(
      searchContentSpec,
      { pattern: 'needle', path: '.git' },
      {
        workspace,
        protectedPathEvaluator,
        workspaceFilesystem: new LegacyWorkspaceFilesystemDispatcherV1({ workspace }),
      },
    );

    expect(result).toMatchObject({ dispatched: true });
    if (!result.dispatched) throw new Error(result.rejection.error);
    expect(result.output.stdout).toContain('needle');
  });

  test('Harness allows a trusted-workspace protected-looking write in accept_edits mode', async () => {
    const workspace = temporaryDirectory('openpx-protected-harness-');
    writeFileSync(join(workspace, '.env'), 'keep');
    const parsed = toolRequestFromCall(
      { id: 'protected-write', name: 'write_file', args: { path: '.env', content: 'changed' } },
      workspace,
    );
    if (!parsed?.ok) throw new Error('write_file request must parse');
    let preimages = 0;

    const result = await invokeGovernedTool({
      workspace,
      request: parsed.request,
      taskConfig: productionBoundaryConfig(workspace),
      workspaceFilesystem: new LegacyWorkspaceFilesystemDispatcherV1({ workspace }),
      recordFilePreimage: () => {
        preimages++;
      },
    });

    expect(preimages).toBe(0);
    if (process.platform === 'win32') {
      expect(result.ok).toBe(false);
      expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('keep');
    } else {
      expect(result.ok).toBe(true);
      expect(readFileSync(join(workspace, '.env'), 'utf8')).toBe('changed');
    }
  });

  test('production writer fails closed when its protected-path gate is missing', async () => {
    const workspace = temporaryDirectory('openpx-protected-missing-gate-');
    const target = join(workspace, 'ordinary.txt');
    writeFileSync(target, 'keep');
    const parsed = toolRequestFromCall(
      { id: 'missing-gate-write', name: 'write_file', args: { path: target, content: 'changed' } },
      workspace,
    );
    if (!parsed?.ok) throw new Error('write_file request must parse');
    const taskConfig = {
      ...productionBoundaryConfig(workspace),
      executionBoundary: undefined,
      executionCapabilitySurface: undefined,
      productionExecution: {},
    } as unknown as AgentConfig;

    const result = await invokeGovernedTool({ workspace, request: parsed.request, taskConfig });

    expect(result).toMatchObject({ ok: false, status: 'rejected' });
    expect(result.stderr).toContain('protected-path gate is unavailable');
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  test('Registry requires external mutation authority but not external read authority', async () => {
    if (process.platform === 'win32') return;
    const workspace = temporaryDirectory('openpx-path-authority-workspace-');
    const outside = temporaryDirectory('openpx-path-authority-outside-');
    const externalFile = join(outside, 'data.txt');
    writeFileSync(externalFile, 'outside');
    const protectedPathEvaluator = createProtectedPathEvaluatorV1({
      workspaceRoot: workspace,
      mode: 'deny',
    });
    const dispatcher = new LegacyWorkspaceFilesystemDispatcherV1({ workspace });

    const read = await dispatchRegisteredTool(
      readFileSpec,
      { path: externalFile },
      {
        workspace,
        protectedPathEvaluator,
        allowExternalPaths: true,
        workspaceFilesystem: dispatcher,
      },
    );
    const deniedWrite = await dispatchRegisteredTool(
      writeFileSpec,
      { path: externalFile, content: 'denied' },
      { workspace, protectedPathEvaluator, workspaceFilesystem: dispatcher },
    );
    const approvedWrite = await dispatchRegisteredTool(
      writeFileSpec,
      { path: externalFile, content: 'approved' },
      {
        workspace,
        protectedPathEvaluator,
        allowExternalPaths: true,
        workspaceFilesystem: dispatcher,
      },
    );

    expect(read).toMatchObject({ dispatched: true });
    expect(deniedWrite).toMatchObject({ dispatched: false });
    expect(approvedWrite).toMatchObject({ dispatched: true });
    expect(readFileSync(externalFile, 'utf8')).toBe('approved');
  });

  test('workspace-wide content search includes protected-looking descendants', async () => {
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
      {
        workspace,
        protectedPathEvaluator,
        workspaceFilesystem: new LegacyWorkspaceFilesystemDispatcherV1({ workspace }),
      },
    );

    expect(result.dispatched).toBe(true);
    if (!result.dispatched) throw new Error(result.rejection.error);
    expect(result.output.stdout).toContain('public.txt');
    expect(result.output.stdout).toContain('.env');
    expect(result.output.stdout).toContain('.kite-code');
    expect(result.output.stdout).toContain('credential');
    expect(result.output.stdout).toContain('agent-config');
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

    await expect(
      manager.connect('protected-interpreter-argument', {
        type: 'stdio',
        command: 'node',
        args: ['.git/hooks/server.js'],
        cwd: workspace,
      }),
    ).rejects.toThrow('arguments by protected-path policy');
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
