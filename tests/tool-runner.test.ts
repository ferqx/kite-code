/**
 * tool-runner 单元测试 — 覆盖 runApprovedTool 各工具分发分支
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingToolRequest } from '../src/core/harness/tool-requests';
import { runApprovedTool } from '../src/core/harness/tool-runner';
import type { McpRuntimeProvider } from '../src/core/mcp';

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

describe('runApprovedTool — list_mcp_resources', () => {
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
      name: 'list_mcp_resources',
      args: {},
      reason: 'discover resources',
      protectedCommand: 'list_mcp_resources',
    };

    const result = await runApprovedTool({ workspace: '/ws', request, mcpManager: manager });
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
      name: 'list_mcp_resources',
      args: { server: 'docs' },
      reason: 'discover resources',
      protectedCommand: 'list_mcp_resources docs',
    };

    const result = await runApprovedTool({ workspace: '/ws', request, mcpManager: manager });
    const output = JSON.parse(result.stdout);
    expect(output.resource_count).toBe(100);
    expect(output.truncated).toBe(true);
  });

  it('distinguishes unknown providers from providers with no static resources', async () => {
    const manager = mockMcpManager(async () => '');
    const known = await runApprovedTool({
      workspace: '/ws',
      request: {
        name: 'list_mcp_resources',
        args: { server: 'test-server' },
        reason: 'discover',
        protectedCommand: 'list_mcp_resources test-server',
      },
      mcpManager: manager,
    });
    const unknown = await runApprovedTool({
      workspace: '/ws',
      request: {
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

describe('runApprovedTool — read_mcp_resource', () => {
  it('returns success with resource content when mcpManager is available', async () => {
    const manager = mockMcpManager(async (_server, _uri) => 'resource content here');
    const request = makeReadMcpResourceRequest();

    const result = await runApprovedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
      approvedGrant: 'approve_once',
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('resource content here');
    expect(result.command).toBe('read_mcp_resource test-server');
    expect(result.resultMeta).toMatchObject({
      truncated: false,
      rawResultDigest: expect.any(String),
    });
  });

  it('returns error when mcpManager is not available', async () => {
    const request = makeReadMcpResourceRequest();

    const result = await runApprovedTool({
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

    const result = await runApprovedTool({
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

    const result = await runApprovedTool({
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
    const result = await runApprovedTool({
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

    const result = await runApprovedTool({
      workspace: '/ws',
      request: makeReadMcpResourceRequest(),
      mcpManager: manager,
      interactionMode: 'auto',
    });

    expect(result.ok).toBe(true);
    expect(readCalled).toBe(true);
  });
});

describe('runApprovedTool — bound MCP policy', () => {
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

    const result = await runApprovedTool({
      workspace: '/ws',
      request: {
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

describe('runApprovedTool — search_files', () => {
  it('finds files without invoking shell', async () => {
    const workspace = join(tmpdir(), 'kite-code-search-files-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{}\n');
    writeFileSync(join(workspace, 'src', 'package.json'), '{}\n');

    const result = await runApprovedTool({
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

    const result = await runApprovedTool({
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
      const result = await runApprovedTool({
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
      const result = await runApprovedTool({
        workspace,
        request: makeSearchFilesRequest('*.ts'),
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('utils.ts');
    }
  });
});

describe('runApprovedTool — shell_execute timeout', () => {
  it('runs proven-local accept_edits shell commands with networking disabled', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await runApprovedTool({
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

  it('opens networking only for an approved network shell command', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await runApprovedTool({
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

  it('opens networking for a full-access network shell command', async () => {
    let capturedNetworkMode: string | undefined;

    const result = await runApprovedTool({
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

  it('does not set a timeout unless the model requested timeout_ms', async () => {
    let capturedTimeout: number | undefined;

    const result = await runApprovedTool({
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

    expect(capturedTimeout).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('passes timeout_ms to the shell executor', async () => {
    let capturedTimeout: number | undefined;

    const result = await runApprovedTool({
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

describe('runApprovedTool 鈥?search_content', () => {
  it('searches file contents without invoking shell', async () => {
    const workspace = join(tmpdir(), 'kite-code-search-content-native');
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'alpha.ts'), 'export const marker = "needle";\n');
    writeFileSync(join(workspace, 'src', 'beta.ts'), 'export const other = true;\n');

    const result = await runApprovedTool({
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
