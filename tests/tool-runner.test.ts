/**
 * tool-runner 单元测试 — 覆盖 runApprovedTool 各工具分发分支
 */
import { describe, expect, it } from 'bun:test';
import type { PendingToolRequest } from '../src/core/harness/tool-requests';
import { runApprovedTool } from '../src/core/harness/tool-runner';
import type { McpManager } from '../src/core/mcp';

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

function mockMcpManager(
  readResourceImpl: (server: string, uri: string) => Promise<string>,
): McpManager {
  return {
    readResource: readResourceImpl,
  } as unknown as McpManager;
}

// ── read_mcp_resource ──

describe('runApprovedTool — read_mcp_resource', () => {
  it('returns success with resource content when mcpManager is available', async () => {
    const manager = mockMcpManager(async (_server, _uri) => 'resource content here');
    const request = makeReadMcpResourceRequest();

    const result = await runApprovedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('resource content here');
    expect(result.command).toBe('read_mcp_resource test-server');
  });

  it('returns error when mcpManager is not available', async () => {
    const request = makeReadMcpResourceRequest();

    const result = await runApprovedTool({
      workspace: '/ws',
      request,
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('MCP manager is not available');
  });

  it('returns error when server is empty', async () => {
    const manager = mockMcpManager(async () => 'content');
    const request = makeReadMcpResourceRequest({
      args: { server: '', uri: 'resource://test' },
    } as any);

    const result = await runApprovedTool({
      workspace: '/ws',
      request,
      mcpManager: manager,
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
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Connection refused');
  });
});

describe('runApprovedTool — search_files', () => {
  it('uses rg --files with glob filters instead of platform-specific find', async () => {
    let command = '';
    const result = await runApprovedTool({
      workspace: '/ws',
      request: makeSearchFilesRequest('package.json'),
      shellExecutor: async (input) => {
        command = input.command;
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: 'package.json\n',
          stderr: '',
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(command).toContain('rg --files');
    expect(command).toContain('-g "package.json"');
    expect(command).toContain('-g "**/package.json"');
    expect(command).not.toContain('find ');
  });

  it('treats empty rg --files matches as a successful empty search', async () => {
    const result = await runApprovedTool({
      workspace: '/ws',
      request: makeSearchFilesRequest('missing.file'),
      shellExecutor: async (input) => ({
        ok: false,
        command: input.command,
        exitCode: 1,
        stdout: '',
        stderr: '',
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
