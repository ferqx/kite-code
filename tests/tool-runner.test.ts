/**
 * tool-runner 单元测试 — 覆盖 invokeGovernedTool 各工具分发分支
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../src/core/config';
import { type PendingToolRequest, toolRequestFromCall } from '../src/core/harness/tool-requests';
import { invokeGovernedTool } from '../src/core/harness/tool-runner';
import type { McpRuntimeProvider } from '../src/core/mcp';
import type { FilePreimageRecorder } from '../src/core/runtime/file-checkpoints';
import { MAX_MODEL_READ_FILE_CHARS } from '../src/core/tools/registry/builtins/read-file';
import { DEFAULT_SHELL_TIMEOUT_MS } from '../src/core/tools/shell';

// ── Helpers ──

function makeReadMcpResourceRequest(
  overrides?: Partial<PendingToolRequest & { args: { server?: string; uri?: string } }>,
): PendingToolRequest {
  return {
    id: 'call-mcp-resource',
    name: 'read_mcp_resource',
    args: { server: 'test-server', uri: 'resource://test' },
    reason: 'Test MCP resource read',
    protectedCommand: 'read_mcp_resource',
    ...overrides,
  } as PendingToolRequest;
}

function makeSearchFilesRequest(pattern: string): PendingToolRequest {
  return {
    id: 'call-search-files',
    name: 'search_files',
    args: { pattern },
    reason: 'Test file search',
    protectedCommand: `search_files ${pattern}`,
  } as PendingToolRequest;
}

function makeSearchContentRequest(pattern: string): PendingToolRequest {
  return {
    id: 'call-search-content',
    name: 'search_content',
    args: { pattern },
    reason: 'Test content search',
    protectedCommand: `search_content ${pattern}`,
  } as PendingToolRequest;
}

function mockMcpManager(
  readResourceImpl: (server: string, uri: string) => Promise<string>,
  resources: Array<{ providerId: string; uri: string; name: string; mimeType?: string }> = [],
): McpRuntimeProvider {
  return {
    getCapabilitySnapshot: () => ({ revision: 'empty', descriptors: [] }),
    getProviderDirectorySnapshot: () => ({
      revision: 'providers',
      entries: [
        {
          providerId: 'test-server',
          status: 'ready',
          required: false,
          source: 'explicit',
          lastKnownCapabilityNames: [],
          retryable: true,
        },
      ],
    }),
    getResourceDirectorySnapshot: () => ({ revision: 'resources', resources }),
    findCapability: () => undefined,
    callCapability: async () => ({ content: [] }),
    readResource: readResourceImpl,
  };
}

describe('invokeGovernedTool — task structure', () => {
  it('does not require a user-goal delegation keyword before dispatch', async () => {
    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-task-review',
        name: 'task',
        args: {
          subagent_type: 'review',
          task: 'Review the reported issues and return file and line evidence.',
        },
        reason: 'Review reported issues',
        protectedCommand: 'task',
      } as PendingToolRequest,
    });

    expect(result.stderr).toContain('task tool is unavailable in this execution context');
    expect(result.stderr).not.toContain('delegation denied');
    expect(result.stderr).not.toContain('user_delegation_not_requested');
  });

  it('rejects delegated tasks outside the structural length boundary', async () => {
    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-task-vague',
        name: 'task',
        args: { subagent_type: 'explore', task: 'short' },
        reason: 'Reject an undersized task',
        protectedCommand: 'task',
      } as PendingToolRequest,
    });

    expect(result.stderr).toContain('Sub-agent task rejected (task_not_bounded)');
  });
});

describe('invokeGovernedTool — list_mcp_resources', () => {
  it('stable-sorts all providers and returns only safe resource metadata', async () => {
    const manager = mockMcpManager(
      async () => '',
      [
        {
          providerId: 'zeta',
          uri: 'docs://z',
          name: 'Z',
          mimeType: 'text/plain',
        },
        { providerId: 'alpha', uri: 'docs://a', name: 'A' },
      ],
    );
    const request: PendingToolRequest = {
      source: 'builtin',
      name: 'list_mcp_resources',
      args: {},
      reason: 'discover resources',
      protectedCommand: 'list_mcp_resources',
    };

    const result = await invokeGovernedTool({ workspace: '/ws', request, mcpManager: manager });
    const output = JSON.parse(result.stdout);

    expect(result.ok).toBe(true);
    expect(output.resources).toEqual([
      { server: 'alpha', uri: 'docs://a', name: 'A' },
      { server: 'zeta', uri: 'docs://z', name: 'Z', mime_type: 'text/plain' },
    ]);
    expect(JSON.stringify(output)).not.toContain('description');
  });

  it('filters by provider, caps output at 100, and reports truncation', async () => {
    const resources = Array.from({ length: 101 }, (_, index) => ({
      providerId: 'docs',
      uri: `docs://${String(index).padStart(3, '0')}`,
      name: `Resource ${index}`,
    }));
    const manager = mockMcpManager(async () => '', resources);
    const request: PendingToolRequest = {
      source: 'builtin',
      name: 'list_mcp_resources',
      args: { server: 'docs' },
      reason: 'discover resources',
      protectedCommand: 'list_mcp_resources docs',
    };

    const result = await invokeGovernedTool({ workspace: '/ws', request, mcpManager: manager });
    const output = JSON.parse(result.stdout);
    expect(output.resource_count).toBe(100);
    expect(output.truncated).toBe(true);
  });

  it('distinguishes unknown providers from providers with no static resources', async () => {
    const manager = mockMcpManager(async () => '');
    const known = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        source: 'builtin' as const,
        name: 'list_mcp_resources',
        args: { server: 'test-server' },
        reason: 'discover',
        protectedCommand: 'list_mcp_resources test-server',
      },
      mcpManager: manager,
    });
    const unknown = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        source: 'builtin' as const,
        name: 'list_mcp_resources',
        args: { server: 'missing' },
        reason: 'discover',
        protectedCommand: 'list_mcp_resources missing',
      },
      mcpManager: manager,
    });

    expect(known.stderr).toContain('No available static MCP resources');
    expect(unknown.stderr).toContain('Unknown MCP server');
  });
});

// ── read_mcp_resource ──

describe('invokeGovernedTool — read_mcp_resource', () => {
  it('returns success with resource content when mcpManager is available', async () => {
    const manager = mockMcpManager(async (_server, _uri) => 'resource content here');
    const request = makeReadMcpResourceRequest();

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
      approvedGrant: 'approve_once',
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('resource content here');
    expect(result.command).toBe(request.protectedCommand);
    expect(result.resultMeta).toMatchObject({
      truncated: false,
      rawResultDigest: expect.any(String),
    });
  });

  it('returns error when mcpManager is not available', async () => {
    const request = makeReadMcpResourceRequest();

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request,
      approvedGrant: 'approve_once',
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('MCP Runtime is not available');
  });

  it('returns error when server is empty', async () => {
    const manager = mockMcpManager(async () => 'content');
    const request = makeReadMcpResourceRequest({
      args: { server: '', uri: 'resource://test' },
    } as Partial<PendingToolRequest & { args: { server?: string; uri?: string } }>);

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
      approvedGrant: 'approve_once',
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('server and uri are required');
  });

  it('returns failure when readResource throws', async () => {
    const manager = mockMcpManager(async () => {
      throw new Error('Connection refused');
    });
    const request = makeReadMcpResourceRequest();

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
      approvedGrant: 'approve_once',
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Connection refused');
  });

  it('bounds oversized resource content without silently truncating it', async () => {
    const manager = mockMcpManager(async () => 'x'.repeat(128 * 1024 + 20));
    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: makeReadMcpResourceRequest(),
      mcpManager: manager,
      approvedGrant: 'approve_once',
    });
    const output = JSON.parse(result.stdout);

    expect(output.status).toBe('partial');
    expect(output.truncated).toBe(true);
    expect(output.original_characters).toBe(128 * 1024 + 20);
    expect(result.resultMeta).toMatchObject({
      truncated: true,
      rawResultDigest: expect.any(String),
    });
  });

  it('allows a governed MCP resource read in auto mode without approval', async () => {
    let readCalled = false;
    const manager = mockMcpManager(async () => {
      readCalled = true;
      return 'resource content';
    });

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: makeReadMcpResourceRequest(),
      mcpManager: manager,
      interactionMode: 'auto',
    });

    expect(result.ok).toBe(true);
    expect(readCalled).toBe(true);
  });
});

describe('invokeGovernedTool — bound MCP policy', () => {
  it('keeps minimum user approval on the manual route in auto mode', async () => {
    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        source: 'mcp',
        id: 'call-user-approved-effect',
        name: 'mcp__auth__write',
        args: { id: '42' },
        reason: 'Update authenticated fixture data',
        protectedCommand: 'mcp__auth__write',
      } as PendingToolRequest,
      interactionMode: 'auto',
      mcpPolicy: {
        effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        minimumApproval: 'user',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.approvalRoute).toBe('user');
  });

  it('executes a binding-validated read-only MCP tool without inventing a second approval', async () => {
    let called = false;
    const manager = {
      callCapability: async () => {
        called = true;
        return {
          content: [{ type: 'text', text: 'authenticated read' }],
          structuredContent: { ok: true },
        };
      },
      findCapability: () => undefined,
    } as unknown as McpRuntimeProvider;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        source: 'mcp',
        id: 'call-authenticated-read',
        name: 'mcp__auth__read',
        args: { id: '42' },
        reason: 'Read authenticated fixture data',
        protectedCommand: 'mcp__auth__read',
      } as PendingToolRequest,
      mcpManager: manager,
      mcpInvocation: { capabilityId: 'mcp:auth/read', expectedRevision: 'revision' },
      mcpPolicy: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
      },
    });

    expect(result.ok, result.stderr).toBe(true);
    expect(result.stdout).toContain('authenticated read');
    expect(called).toBe(true);
  });
});

describe('invokeGovernedTool — search_files', () => {
  it('finds files without invoking shell', async () => {
    const workspace = join(tmpdir(), 'kite-code-search-files-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{}\n');
    writeFileSync(join(workspace, 'src', 'package.json'), '{}\n');

    const result = await invokeGovernedTool({
      workspace,
      request: makeSearchFilesRequest('package.json'),
      shellExecutor: async () => {
        throw new Error('search_files must not invoke shell');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('package.json');
    expect(result.stdout).toContain('src/package.json');
    expect(result.command).toBe('search_files package.json');
  });

  it('returns success with empty stdout when no files match', async () => {
    const workspace = join(tmpdir(), 'kite-code-search-files-empty-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await invokeGovernedTool({
      workspace,
      request: makeSearchFilesRequest('missing.file'),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  // Windows MSYS2 路径转换：/d/foo/bar → D:\foo\bar，防止 resolve 误判为工作区越界
  // MSYS2 path normalization: /d/foo/bar → D:\foo\bar to avoid false workspace-boundary rejection
  it('normalizes MSYS2 path in search_files to avoid workspace-boundary rejection', async () => {
    const workspace = join(tmpdir(), 'kite-code-msys2-search-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'lib'), { recursive: true });
    writeFileSync(join(workspace, 'lib', 'utils.ts'), 'export const x = 1;\n');

    if (process.platform === 'win32') {
      // Simulate Git Bash style path: /d/.../lib
      const msys2Style = workspace.replace(/\\/g, '/').replace(/^([A-Z]):/, '/$1');
      const result = await invokeGovernedTool({
        workspace,
        request: {
          id: 'call-msys2',
          name: 'search_files',
          args: { pattern: '*.ts', path: msys2Style },
          reason: 'Test MSYS2 path',
          protectedCommand: `search_files *.ts`,
        } as PendingToolRequest,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('utils.ts');
    } else {
      // Non-Windows: just verify normal search still works
      const result = await invokeGovernedTool({
        workspace,
        request: makeSearchFilesRequest('*.ts'),
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('utils.ts');
    }
  });
});

describe('invokeGovernedTool — shell_execute timeout', () => {
  it('runs proven-local accept_edits shell commands with networking disabled', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-local',
        name: 'shell_execute',
        args: { command: 'touch local.txt' },
        reason: 'Write a workspace file',
        protectedCommand: 'touch local.txt',
      } as PendingToolRequest,
      interactionMode: 'accept_edits',
      shellExecutor: async (input) => {
        capturedNetworkMode = input.networkMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedNetworkMode).toBe('disabled');
  });

  it('runs exact local runtime version queries with networking disabled', async () => {
    const capturedNetworkModes: string[] = [];

    for (const command of ['node --version', 'npm --version', 'bun --version']) {
      const result = await invokeGovernedTool({
        workspace: '/ws',
        request: {
          id: `call-runtime-version-${command}`,
          name: 'shell_execute',
          args: { command },
          reason: 'Inspect the local runtime version',
          protectedCommand: command,
        } as PendingToolRequest,
        interactionMode: 'accept_edits',
        shellExecutor: async (input) => {
          capturedNetworkModes.push(input.networkMode ?? 'missing');
          return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(result.ok).toBe(true);
    }

    expect(capturedNetworkModes).toEqual(['disabled', 'disabled', 'disabled']);
  });

  it('opens networking only for an approved network shell command', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-network',
        name: 'shell_execute',
        args: { command: 'curl https://example.com' },
        reason: 'Fetch a URL',
        protectedCommand: 'curl https://example.com',
      } as PendingToolRequest,
      interactionMode: 'accept_edits',
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedNetworkMode = input.networkMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedNetworkMode).toBe('allow_all');
  });

  it('does not revoke an approved development network grant when a boundary is present', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'tool-runner-network-boundary-'));
    let capturedNetworkMode: string | undefined;
    try {
      const result = await invokeGovernedTool({
        workspace,
        request: {
          id: 'call-shell-network-boundary',
          name: 'shell_execute',
          args: { command: 'curl https://example.com' },
          reason: 'Fetch an approved URL',
          protectedCommand: 'curl https://example.com',
        } as PendingToolRequest,
        interactionMode: 'accept_edits',
        approvedGrant: 'approve_once',
        taskConfig: {
          features: { networkBoundaryV1: true },
          executionBoundary: {
            filesystemScope: 'workspace_write',
            workspaceRoot: workspace,
            networkMode: 'off',
            networkAllowlist: [],
            allowLocalAndPrivateNetwork: false,
            protectedPathPolicy: 'deny',
            maxProcessTreeSizePerShellInvocation: 16,
            sandboxRequired: true,
            sandboxUnavailable: 'fail',
          },
        } as unknown as AgentConfig,
        shellExecutor: async (input) => {
          capturedNetworkMode = input.networkMode;
          return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
        },
      });
      expect(result.ok).toBe(true);
      expect(capturedNetworkMode).toBe('allow_all');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('projects approved external writes to the cross-platform filesystem lane', async () => {
    let capturedFilesystemMode: string | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-external-write',
        name: 'shell_execute',
        args: { command: 'touch /tmp/kite-approved-write.txt' },
        reason: 'Write an approved temporary file',
        protectedCommand: 'touch /tmp/kite-approved-write.txt',
      } as PendingToolRequest,
      interactionMode: 'accept_edits',
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedFilesystemMode = input.filesystemMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedFilesystemMode).toBe('allow_all');
  });

  it('projects both network and external-filesystem approval for curl output files', async () => {
    let capturedNetworkMode: string | undefined;
    let capturedFilesystemMode: string | undefined;
    const command = 'curl -o /tmp/out https://example.com';

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-network-output',
        name: 'shell_execute',
        args: { command },
        reason: 'Download an approved temporary file',
        protectedCommand: command,
      } as PendingToolRequest,
      interactionMode: 'accept_edits',
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedNetworkMode = input.networkMode;
        capturedFilesystemMode = input.filesystemMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedNetworkMode).toBe('allow_all');
    expect(capturedFilesystemMode).toBe('allow_all');
  });

  it('keeps approved workspace-only writes in the native sandbox lane', async () => {
    let capturedFilesystemMode: string | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-workspace-write',
        name: 'shell_execute',
        args: { command: 'touch local.txt' },
        reason: 'Write a workspace file',
        protectedCommand: 'touch local.txt',
      } as PendingToolRequest,
      interactionMode: 'accept_edits',
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedFilesystemMode = input.filesystemMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedFilesystemMode).toBe('workspace_only');
  });

  it('opens networking for a full-access network shell command', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-full-network',
        name: 'shell_execute',
        args: { command: 'curl https://example.com' },
        reason: 'Fetch a URL',
        protectedCommand: 'curl https://example.com',
      } as PendingToolRequest,
      interactionMode: 'full',
      authorization: { mode: 'full_access', commandGrants: {} },
      shellExecutor: async (input) => {
        capturedNetworkMode = input.networkMode;
        return { ok: true, command: input.command, exitCode: 0, stdout: '', stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedNetworkMode).toBe('allow_all');
  });

  it('applies the default hard timeout when the model omits timeout_ms', async () => {
    let capturedTimeout: number | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-no-timeout',
        name: 'shell_execute',
        args: { command: 'npm run build' },
        reason: 'Test shell default timeout',
        protectedCommand: 'npm run build',
      } as PendingToolRequest,
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedTimeout = input.timeoutMs;
        return { ok: true, command: input.command, exitCode: 0, stdout: 'built', stderr: '' };
      },
    });

    expect(capturedTimeout).toBe(DEFAULT_SHELL_TIMEOUT_MS);
    expect(result.ok).toBe(true);
  });

  it('passes timeout_ms to the shell executor', async () => {
    let capturedTimeout: number | undefined;

    const result = await invokeGovernedTool({
      workspace: '/ws',
      request: {
        id: 'call-shell-timeout',
        name: 'shell_execute',
        args: { command: 'sleep 5', timeout_ms: 250 },
        reason: 'Test shell timeout',
        protectedCommand: 'sleep 5',
      } as PendingToolRequest,
      approvedGrant: 'approve_once',
      shellExecutor: async (input) => {
        capturedTimeout = input.timeoutMs;
        return { ok: false, command: input.command, exitCode: 124, stdout: '', stderr: 'timeout' };
      },
    });

    expect(capturedTimeout).toBe(250);
    expect(result.exitCode).toBe(124);
  });
});

describe('invokeGovernedTool — approved external file paths', () => {
  it('writes a relative traversal target after approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-approved-file-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.txt');
    mkdirSync(workspace);
    try {
      const result = await invokeGovernedTool({
        workspace,
        request: {
          id: 'call-write-relative-external',
          name: 'write_file',
          args: { path: '../outside.txt', content: 'approved' },
          reason: 'Write an approved external file',
          protectedCommand: 'write_file ../outside.txt',
        } as PendingToolRequest,
        interactionMode: 'accept_edits',
        approvedGrant: 'approve_once',
      });

      expect(result.ok).toBe(true);
      expect(await Bun.file(outside).text()).toBe('approved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('invokeGovernedTool 鈥?search_content', () => {
  it('searches file contents without invoking shell', async () => {
    const workspace = join(tmpdir(), 'kite-code-search-content-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'alpha.ts'), 'export const marker = "needle";\n');
    writeFileSync(join(workspace, 'src', 'beta.ts'), 'export const other = true;\n');

    const result = await invokeGovernedTool({
      workspace,
      request: makeSearchContentRequest('needle'),
      shellExecutor: async () => {
        throw new Error('search_content must not invoke shell');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('src/alpha.ts:1:export const marker = "needle";');
    expect(result.stdout).not.toContain('beta.ts');
    expect(result.command).toBe('search_content needle');
    expect(result.resultMeta).toEqual({
      path: '.',
      matchCount: 1,
      truncated: false,
      rawResultDigest: expect.any(String),
    });
  });
});

// ── ADR-0042 §4：写入前文件原像捕获 / file pre-image capture ──

describe('invokeGovernedTool — file pre-image capture (ADR-0042 §4)', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kite-code-preimage-capture-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function requestOf(name: string, args: Record<string, unknown>): PendingToolRequest {
    const result = toolRequestFromCall({ id: 'capture-call', name, args }, workspace);
    if (!result?.ok) throw new Error(`Failed to build request for ${name}`);
    return result.request;
  }

  function checkpointRecorder(
    captured: Array<[string, string | null, boolean]>,
    postimages: Array<[string, string | null, boolean]>,
  ): FilePreimageRecorder {
    const recorder: FilePreimageRecorder = (path, content, existed) => {
      captured.push([path, content, existed]);
    };
    recorder.recordPostimage = (path, content, existed) => {
      postimages.push([path, content, existed]);
    };
    return recorder;
  }

  it('captures the pre-image before write_file overwrites an existing file', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8');
    const captured: Array<[string, string | null, boolean]> = [];
    const postimages: Array<[string, string | null, boolean]> = [];
    const result = await invokeGovernedTool({
      workspace,
      request: requestOf('write_file', { path: 'notes.md', content: 'v2\n' }),
      recordFilePreimage: checkpointRecorder(captured, postimages),
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([['notes.md', 'v1\n', true]]);
    expect(postimages).toEqual([['notes.md', 'v2\n', true]]);
  });

  it('records existed=false when write_file creates a new file', async () => {
    const captured: Array<[string, string | null, boolean]> = [];
    const postimages: Array<[string, string | null, boolean]> = [];
    const result = await invokeGovernedTool({
      workspace,
      request: requestOf('write_file', { path: 'fresh.md', content: 'hi\n' }),
      recordFilePreimage: checkpointRecorder(captured, postimages),
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([['fresh.md', null, false]]);
    expect(postimages).toEqual([['fresh.md', 'hi\n', true]]);
  });

  it('does not record a post-image when write_file fails', async () => {
    const lockedDirectory = join(workspace, 'locked');
    mkdirSync(lockedDirectory);
    chmodSync(lockedDirectory, 0o500);
    const captured: Array<[string, string | null, boolean]> = [];
    const postimages: Array<[string, string | null, boolean]> = [];
    try {
      const result = await invokeGovernedTool({
        workspace,
        request: requestOf('write_file', { path: 'locked/notes.md', content: 'v2\n' }),
        recordFilePreimage: checkpointRecorder(captured, postimages),
      });
      expect(result.ok).toBe(false);
      expect(captured).toEqual([['locked/notes.md', null, false]]);
      expect(postimages).toEqual([]);
    } finally {
      chmodSync(lockedDirectory, 0o700);
    }
  });

  it('captures the pre-image before edit_file replaces content', async () => {
    writeFileSync(join(workspace, 'code.ts'), 'const a = 1;\n', 'utf8');
    // ADR-0042 §1：先读后改——先经 read_file 登记读取状态，edit 才能通过校验。
    await invokeGovernedTool({
      workspace,
      request: requestOf('read_file', { path: 'code.ts' }),
    });
    const captured: Array<[string, string | null, boolean]> = [];
    const postimages: Array<[string, string | null, boolean]> = [];
    const result = await invokeGovernedTool({
      workspace,
      request: requestOf('edit_file', {
        path: 'code.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
      }),
      recordFilePreimage: checkpointRecorder(captured, postimages),
    });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([['code.ts', 'const a = 1;\n', true]]);
    expect(postimages).toEqual([['code.ts', 'const a = 2;\n', true]]);
  });

  it('a throwing recorder never fails the tool', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'v1\n', 'utf8');
    const result = await invokeGovernedTool({
      workspace,
      request: requestOf('write_file', { path: 'notes.md', content: 'v2\n' }),
      recordFilePreimage: () => {
        throw new Error('recorder down');
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe('invokeGovernedTool — actor-scoped read-before-edit', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'kite-code-read-state-actor-'));
    writeFileSync(join(workspace, 'parent.ts'), 'export const owner = "parent";\n', 'utf8');
    writeFileSync(join(workspace, 'child.ts'), 'export const owner = "child";\n', 'utf8');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function requestOf(name: string, args: Record<string, unknown>): PendingToolRequest {
    const result = toolRequestFromCall({ id: `${name}-call`, name, args }, workspace);
    if (!result?.ok) throw new Error(`Failed to build request for ${name}`);
    return result.request;
  }

  async function runFileTool(
    name: string,
    args: Record<string, unknown>,
    readStateActorId?: string,
  ) {
    return invokeGovernedTool({
      workspace,
      threadId: 'shared-thread',
      readStateActorId,
      request: requestOf(name, args),
    });
  }

  it('does not let parent, child, or sibling actors lend freshness to one another', async () => {
    expect((await runFileTool('read_file', { path: 'parent.ts' })).ok).toBe(true);

    const childUsingParentRead = await runFileTool(
      'edit_file',
      {
        path: 'parent.ts',
        old_string: 'export const owner = "parent";',
        new_string: 'export const owner = "child-a";',
      },
      'child-a',
    );
    expect(childUsingParentRead.ok).toBe(false);
    expect(childUsingParentRead.stderr).toContain('File has not been read yet');

    expect((await runFileTool('read_file', { path: 'child.ts' }, 'child-a')).ok).toBe(true);
    const siblingUsingChildRead = await runFileTool(
      'edit_file',
      {
        path: 'child.ts',
        old_string: 'export const owner = "child";',
        new_string: 'export const owner = "child-b";',
      },
      'child-b',
    );
    expect(siblingUsingChildRead.ok).toBe(false);
    expect(siblingUsingChildRead.stderr).toContain('File has not been read yet');

    // Reusing the stable actor id models an in-process suspend/resume continuation.
    const continuedChild = await runFileTool(
      'edit_file',
      {
        path: 'child.ts',
        old_string: 'export const owner = "child";',
        new_string: 'export const owner = "child-a";',
      },
      'child-a',
    );
    expect(continuedChild.ok).toBe(true);

    const continuedParent = await runFileTool('edit_file', {
      path: 'parent.ts',
      old_string: 'export const owner = "parent";',
      new_string: 'export const owner = "main";',
    });
    expect(continuedParent.ok).toBe(true);
  });

  it('keeps the Runner result bounded while recording freshness from the complete file', async () => {
    const lines = [
      'export const first = 1;',
      ...Array.from({ length: 2_500 }, (_, index) => `export const value${index} = ${index};`),
    ];
    writeFileSync(join(workspace, 'large.ts'), `${lines.join('\n')}\n`, 'utf8');

    const read = await runFileTool('read_file', { path: 'large.ts', limit: 2_501 });
    expect(read.ok).toBe(true);
    expect(read.stdout.length).toBeLessThanOrEqual(MAX_MODEL_READ_FILE_CHARS);
    expect(read.stdout).toContain('continue with offset=');
    expect(read.resultMeta).toMatchObject({
      path: 'large.ts',
      totalLines: 2_501,
      truncated: true,
      rawResultDigest: expect.any(String),
    });

    const edit = await runFileTool('edit_file', {
      path: 'large.ts',
      old_string: 'export const first = 1;',
      new_string: 'export const first = 2;',
    });
    expect(edit.ok).toBe(true);
  });
});
