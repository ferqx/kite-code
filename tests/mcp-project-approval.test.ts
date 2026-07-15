import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfigCatalog } from '@/core/config';
import {
  computeProjectMcpConfigDigest,
  decideProjectMcpServer,
} from '@/core/config/mcp-project-approvals';

describe('project MCP approval', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let sourcePath: string;
  let previousHome: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kite-mcp-approval-'));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    sourcePath = join(workspace, '.mcp.json');
    mkdirSync(join(home, '.kite-code'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    previousHome = process.env.KITE_CODE_HOME;
    previousCwd = process.cwd();
    process.env.KITE_CODE_HOME = home;
    process.chdir(workspace);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  function writeProjectConfig(config: Record<string, unknown>): void {
    writeFileSync(sourcePath, JSON.stringify({ mcpServers: { project: config } }, null, 2));
  }

  test('digest is key-order independent but includes array order and unknown fields', () => {
    const first = computeProjectMcpConfigDigest({
      serverName: 'project',
      sourceKind: 'project_mcp_json',
      rawConfig: { command: 'node', args: ['a', 'b'], futureBehavior: true },
    });
    const reordered = computeProjectMcpConfigDigest({
      serverName: 'project',
      sourceKind: 'project_mcp_json',
      rawConfig: { futureBehavior: true, args: ['a', 'b'], command: 'node' },
    });
    const changedArray = computeProjectMcpConfigDigest({
      serverName: 'project',
      sourceKind: 'project_mcp_json',
      rawConfig: { command: 'node', args: ['b', 'a'], futureBehavior: true },
    });
    const changedUnknown = computeProjectMcpConfigDigest({
      serverName: 'project',
      sourceKind: 'project_mcp_json',
      rawConfig: { command: 'node', args: ['a', 'b'], futureBehavior: false },
    });

    expect(reordered).toBe(first);
    expect(changedArray).not.toBe(first);
    expect(changedUnknown).not.toBe(first);
  });

  test('approval enables only the exact config and strips project policy relaxation', () => {
    writeProjectConfig({
      command: 'node',
      args: ['server.js'],
      trust: 'trusted',
      tools: {
        mutate: {
          effects: { externalState: 'none' },
          minimumApproval: 'none',
          retry: 'safe_read',
        },
      },
    });
    const pending = loadMcpConfigCatalog();
    const view = pending.projectApprovals[0]!;
    expect(view.status).toBe('pending_approval');
    expect(pending.connectableServers.project).toBeUndefined();

    const result = decideProjectMcpServer({
      workspace,
      serverName: view.name,
      sourceKind: view.sourceKind,
      sourcePath: view.sourcePath,
      expectedConfigDigest: view.configDigest,
      decision: 'approved',
    });
    expect(result.status).toBe('recorded');

    const approved = loadMcpConfigCatalog();
    expect(approved.projectApprovals[0]?.status).toBe('approved');
    expect(approved.connectableServers.project?.trust).toBe('untrusted');
    expect(approved.connectableServers.project?.tools).toBeUndefined();
    const storePath = join(home, '.kite-code', 'mcp-project-approvals.jsonc');
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(storePath, 'utf8')).not.toContain('server.js');

    writeProjectConfig({ command: 'node', args: ['changed.js'] });
    const changed = loadMcpConfigCatalog();
    expect(changed.projectApprovals[0]?.status).toBe('pending_approval');
    expect(changed.connectableServers.project).toBeUndefined();
  });

  test('keeps Phase 0 project_mcp_json approval records valid after source renaming', () => {
    const raw = { command: 'node', args: ['server.js'] };
    writeProjectConfig(raw);
    const legacyDigest = computeProjectMcpConfigDigest({
      serverName: 'project',
      sourceKind: 'project_mcp_json',
      rawConfig: raw,
    });
    expect(
      decideProjectMcpServer({
        workspace,
        serverName: 'project',
        sourceKind: 'project_mcp_json',
        sourcePath,
        expectedConfigDigest: legacyDigest,
        decision: 'approved',
      }).status,
    ).toBe('recorded');

    const catalog = loadMcpConfigCatalog();
    expect(catalog.effective.get('project')?.source.kind).toBe('project');
    expect(catalog.effective.get('project')?.approvalStatus).toBe('approved');
    expect(catalog.connectableServers.project?.command).toBe('node');
  });

  test('reject persists and config change returns to pending', () => {
    writeProjectConfig({ command: 'node', args: ['server.js'] });
    const view = loadMcpConfigCatalog().projectApprovals[0]!;
    expect(
      decideProjectMcpServer({
        workspace,
        serverName: view.name,
        sourceKind: view.sourceKind,
        sourcePath: view.sourcePath,
        expectedConfigDigest: view.configDigest,
        decision: 'rejected',
      }).status,
    ).toBe('recorded');
    expect(loadMcpConfigCatalog().projectApprovals[0]?.status).toBe('rejected');

    writeProjectConfig({ command: 'node', args: ['other.js'] });
    expect(loadMcpConfigCatalog().projectApprovals[0]?.status).toBe('pending_approval');
  });

  test('TOCTOU check refuses to record a stale digest', () => {
    writeProjectConfig({ command: 'node', args: ['before.js'] });
    const view = loadMcpConfigCatalog().projectApprovals[0]!;
    writeProjectConfig({ command: 'node', args: ['after.js'] });

    const result = decideProjectMcpServer({
      workspace,
      serverName: view.name,
      sourceKind: view.sourceKind,
      sourcePath: view.sourcePath,
      expectedConfigDigest: view.configDigest,
      decision: 'approved',
    });
    expect(result.status).toBe('config_changed');
  });

  test('malformed approval store fails closed and is not overwritten', () => {
    writeProjectConfig({ command: 'node', args: ['server.js'] });
    const storePath = join(home, '.kite-code', 'mcp-project-approvals.jsonc');
    writeFileSync(storePath, '{ broken');

    const catalog = loadMcpConfigCatalog();
    expect(catalog.projectApprovals[0]?.status).toBe('store_corrupt');
    expect(catalog.connectableServers.project).toBeUndefined();
    expect(readFileSync(storePath, 'utf8')).toBe('{ broken');
  });
});
