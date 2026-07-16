import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, loadMcpConfigCatalog } from '@/core/config';

describe('MCP source-aware config catalog', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let previousHome: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kite-mcp-catalog-'));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    mkdirSync(join(home, '.kite-code'), { recursive: true });
    mkdirSync(join(workspace, '.kite-code'), { recursive: true });
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

  test('uses legacy project > project > user precedence without fallback', () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ mcpServers: { shared: { command: 'user-server' } } }),
    );
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'legacy-project-server' } } }),
    );
    writeFileSync(
      join(workspace, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ mcpServers: { shared: { command: 'project-server' } } }),
    );

    const catalog = loadMcpConfigCatalog();
    const effective = catalog.effective.get('shared');
    expect(effective?.source.kind).toBe('project_legacy');
    expect(effective?.approvalStatus).toBe('pending_approval');
    expect(catalog.connectableServers.shared).toBeUndefined();
    expect(catalog.entries.find((entry) => entry.source.kind === 'user')?.shadowedBy).toBe(
      'project_legacy',
    );
  });

  test('project declaration shadows user and remains gated', () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ mcpServers: { shared: { command: 'user-server' } } }),
    );
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'project-server' } } }),
    );

    const loaded = loadMcpConfig();
    expect(loaded.catalog.effective.get('shared')?.source.kind).toBe('project');
    expect(loaded.catalog.effective.get('shared')?.approvalStatus).toBe('pending_approval');
    expect(loaded.servers.shared).toBeUndefined();
  });

  test('explicit config is caller-authorized and does not merge workspace sources', () => {
    const explicitPath = join(root, 'explicit.jsonc');
    writeFileSync(
      explicitPath,
      JSON.stringify({ mcpServers: { explicit: { command: 'explicit-server' } } }),
    );
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { project: { command: 'project-server' } } }),
    );

    const loaded = loadMcpConfig(explicitPath);
    expect(Object.keys(loaded.servers)).toEqual(['explicit']);
    expect(loaded.catalog.entries[0]?.source.kind).toBe('explicit');
  });

  test('keeps invalid project entries visible but non-connectable', () => {
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { broken: { type: 'http' } } }),
    );

    const catalog = loadMcpConfigCatalog();
    expect(catalog.effective.get('broken')?.approvalStatus).toBe('invalid');
    expect(catalog.connectableServers.broken).toBeUndefined();
    expect(catalog.projectApprovals[0]?.diagnostics).toContain('HTTP MCP server requires a URL.');
  });

  test('redacts HTTP credentials and query parameters from the approval view', () => {
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://user:password@example.com/mcp?token=secret#fragment',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      }),
    );

    const view = loadMcpConfigCatalog().projectApprovals[0]!;
    expect(view.review.endpoint).toBe('https://example.com');
    expect(JSON.stringify(view)).not.toContain('password');
    expect(JSON.stringify(view)).not.toContain('secret');
  });

  test('keeps only credential references and OAuth metadata in normalized config', () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({
        mcpServers: {
          bearer: {
            type: 'http',
            url: 'https://mcp.example.com',
            auth: {
              type: 'credential',
              header: 'Authorization',
              credentialRef: 'work-account',
              scheme: 'Bearer',
            },
          },
          oauth: {
            type: 'http',
            url: 'https://oauth.example.com',
            auth: { type: 'oauth', credentialRef: 'oauth-account', scopes: ['mcp:tools'] },
          },
        },
      }),
    );

    const catalog = loadMcpConfigCatalog();
    expect(catalog.connectableServers.bearer?.auth).toEqual({
      type: 'credential',
      header: 'Authorization',
      credentialRef: 'work-account',
      scheme: 'Bearer',
    });
    expect(catalog.connectableServers.oauth?.auth).toEqual({
      type: 'oauth',
      credentialRef: 'oauth-account',
      scopes: ['mcp:tools'],
    });
    expect(JSON.stringify(catalog.connectableServers)).not.toContain('access-secret');
  });

  test('rejects inline OAuth client secrets instead of silently ignoring them', () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({
        mcpServers: {
          oauth: {
            type: 'http',
            url: 'https://oauth.example.com',
            auth: { type: 'oauth', clientSecret: 'inline-secret' },
          },
        },
      }),
    );
    const entry = loadMcpConfigCatalog().effective.get('oauth');
    expect(entry?.approvalStatus).toBe('invalid');
    expect(entry?.normalizedConfig).toBeUndefined();
  });

  test('rejects authentication configuration on stdio servers', () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({
        mcpServers: {
          local: {
            command: 'local-server',
            auth: { type: 'environment', header: 'Authorization', env: 'LOCAL_TOKEN' },
          },
        },
      }),
    );

    const entry = loadMcpConfigCatalog().effective.get('local');
    expect(entry?.approvalStatus).toBe('invalid');
    expect(entry?.normalizedConfig).toBeUndefined();
  });
});
