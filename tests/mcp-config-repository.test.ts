import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DefaultMcpConfigRepository,
  loadMcpConfigCatalog,
  type McpConfigMutationError,
} from '@/core/config';

describe('MCP config repository', () => {
  let root: string;
  let home: string;
  let workspace: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kite-mcp-repository-'));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    mkdirSync(join(home, '.kite-code'), { recursive: true });
    mkdirSync(join(workspace, '.kite-code'), { recursive: true });
    previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('uses local > legacy > project > user precedence and reveals lower scope after remove', async () => {
    writeFileSync(
      join(home, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ mcpServers: { shared: { command: 'user' } } }),
    );
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'project' } } }),
    );
    writeFileSync(
      join(workspace, '.kite-code', 'kite-code.jsonc'),
      JSON.stringify({ mcpServers: { shared: { command: 'legacy' } } }),
    );
    const repository = new DefaultMcpConfigRepository();
    let catalog = await repository.load(workspace);
    await repository.mutate({
      type: 'add',
      scope: 'local',
      name: 'shared',
      config: { type: 'stdio', command: 'local' },
      expectedRevision: catalog.sourceRevisions.local,
    });

    catalog = await repository.load(workspace);
    expect(catalog.effective.get('shared')?.source.kind).toBe('local');
    const local = catalog.effective.get('shared')!;
    catalog = await repository.mutate({
      type: 'remove',
      key: { name: 'shared', source: 'local' },
      expectedRevision: local.revision,
    });
    expect(catalog.effective.get('shared')?.source.kind).toBe('project_legacy');
  });

  test('preserves unrelated JSONC comments and detects external modification conflicts', async () => {
    const userPath = join(home, '.kite-code', 'kite-code.jsonc');
    writeFileSync(
      userPath,
      '{\n  // keep provider comment\n  "provider": {},\n  "mcpServers": {}\n}\n',
    );
    const repository = new DefaultMcpConfigRepository();
    let catalog = await repository.load(workspace);
    catalog = await repository.mutate({
      type: 'add',
      scope: 'user',
      name: 'demo',
      config: { type: 'stdio', command: 'node', cwd: 'C:\\work\\demo' },
      expectedRevision: catalog.sourceRevisions.user,
    });
    expect(readFileSync(userPath, 'utf8')).toContain('// keep provider comment');
    expect(catalog.effective.get('demo')?.rawConfig.cwd).toBe('C:\\work\\demo');
    let entry = catalog.entries.find(
      (candidate) => candidate.name === 'demo' && candidate.source.kind === 'user',
    )!;
    catalog = await repository.mutate({
      type: 'update',
      key: { name: entry.name, source: entry.source.kind },
      expectedRevision: entry.revision,
      patch: {
        cwd: 'D:\\repo\\next',
        required: true,
        enabledTools: ['read'],
        disabledTools: ['write'],
        tools: {
          read: {
            enabled: true,
            effects: { filesystem: 'read', network: 'read', externalState: 'read' },
            minimumApproval: 'none',
            retry: 'safe_read',
          },
        },
      },
    });
    expect(catalog.effective.get('demo')?.rawConfig).toMatchObject({
      cwd: 'D:\\repo\\next',
      required: true,
      enabledTools: ['read'],
      disabledTools: ['write'],
      tools: {
        read: {
          enabled: true,
          effects: { filesystem: 'read', network: 'read', externalState: 'read' },
          minimumApproval: 'none',
          retry: 'safe_read',
        },
      },
    });
    entry = catalog.entries.find(
      (candidate) => candidate.name === 'demo' && candidate.source.kind === 'user',
    )!;

    writeFileSync(
      userPath,
      readFileSync(userPath, 'utf8').replace('"provider": {}', '"theme": "dark"'),
    );
    await expect(
      repository.mutate({
        type: 'set_enabled',
        key: { name: 'demo', source: 'user' },
        expectedRevision: entry.revision,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'config_conflict' } satisfies Partial<McpConfigMutationError>);
    expect(readFileSync(userPath, 'utf8')).not.toContain('"enabled": false');
  });

  test('disables without deleting environment placeholders', async () => {
    const repository = new DefaultMcpConfigRepository();
    let catalog = await repository.load(workspace);
    catalog = await repository.mutate({
      type: 'add',
      scope: 'local',
      name: 'env-demo',
      config: {
        type: 'stdio',
        command: 'node',
        env: { TOKEN: '$' + '{MCP_TOKEN}' },
      },
      expectedRevision: catalog.sourceRevisions.local,
    });
    const entry = catalog.effective.get('env-demo')!;
    catalog = await repository.mutate({
      type: 'set_enabled',
      key: { name: entry.name, source: entry.source.kind },
      expectedRevision: entry.revision,
      enabled: false,
    });
    const disabled = catalog.effective.get('env-demo')!;
    expect(disabled.enabled).toBe(false);
    expect(catalog.connectableServers['env-demo']).toBeUndefined();
    expect(JSON.stringify(disabled.rawConfig)).toContain('$' + '{MCP_TOKEN}');
  });

  test('migrates legacy project config without dropping unrelated config', async () => {
    const legacyPath = join(workspace, '.kite-code', 'kite-code.jsonc');
    writeFileSync(
      legacyPath,
      '{\n  // project settings\n  "theme": "dark",\n  "mcpServers": { "legacy": { "command": "node" } }\n}\n',
    );
    const repository = new DefaultMcpConfigRepository();
    let catalog = await repository.load(workspace);
    const legacy = catalog.effective.get('legacy')!;
    catalog = await repository.mutate({
      type: 'migrate_legacy',
      key: { name: legacy.name, source: legacy.source.kind },
      expectedRevision: legacy.revision,
      target: 'project',
    });

    expect(catalog.effective.get('legacy')?.source.kind).toBe('project');
    expect(readFileSync(legacyPath, 'utf8')).toContain('// project settings');
    expect(readFileSync(legacyPath, 'utf8')).toContain('"theme": "dark"');
    expect(readFileSync(join(workspace, '.mcp.json'), 'utf8')).toContain('"legacy"');
    expect(catalog.effective.get('legacy')?.approvalStatus).toBe('pending_approval');
  });

  test('watch rebinds when a missing local scope is created and manual load remains available', async () => {
    const repository = new DefaultMcpConfigRepository({ debounceMs: 10 });
    let catalog = await repository.load(workspace);
    let calls = 0;
    const stop = repository.watch(workspace, () => calls++);
    catalog = await repository.mutate({
      type: 'add',
      scope: 'local',
      name: 'watched',
      config: { type: 'stdio', command: 'first' },
      expectedRevision: catalog.sourceRevisions.local,
    });
    await Bun.sleep(120);
    calls = 0;
    const localPath = catalog.effective.get('watched')!.source.path;
    writeFileSync(localPath, '{ "mcpServers": { "watched": { "command": "second" } } }\n');
    await Bun.sleep(120);
    stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect((await repository.load(workspace)).effective.get('watched')?.rawConfig.command).toBe(
      'second',
    );
    expect(existsSync(localPath)).toBe(true);
  });

  test('projects added through the repository remain pending instead of self-approving', async () => {
    const repository = new DefaultMcpConfigRepository();
    const catalog = await repository.load(workspace);
    const next = await repository.mutate({
      type: 'add',
      scope: 'project',
      name: 'shared-demo',
      config: { type: 'http', url: 'https://example.com/mcp' },
      expectedRevision: catalog.sourceRevisions.project,
    });
    expect(next.effective.get('shared-demo')?.approvalStatus).toBe('pending_approval');
    expect(next.connectableServers['shared-demo']).toBeUndefined();
    expect(loadMcpConfigCatalog({ workspace }).projectApprovals).toHaveLength(1);
  });
});
