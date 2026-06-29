/**
 * tool-runner 单元测试 — 覆盖 runApprovedTool 各工具分发分支
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  });
});
