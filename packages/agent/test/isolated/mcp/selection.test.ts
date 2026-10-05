import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type McpRegistry, readMcpSelection, updateMcpSelection } from '../../../src/config';

test('MCP selection checks full registry and other source again inside original publication lock without replacing comments or unknown fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-mcp-select-cas-')),
    userPath = join(root, 'user.jsonc'),
    workspacePath = join(root, 'workspace.jsonc');
  const original =
    '{// KEEP\n"unknown":{"exact":7},"mcp":[{"id":"one","unknown":true,"enabled":true}]}';
  writeFileSync(userPath, original);
  writeFileSync(workspacePath, '{}');
  const registry: McpRegistry = {
    revision: '1',
    servers: [
      {
        id: 'one',
        configDigest: 'a'.repeat(64),
        transport: 'http',
        source: { kind: 'programmatic', id: 'owned', revision: '1' },
        admitted: true,
      },
    ],
  };
  const base = {
    userPath,
    workspacePath,
    sourceIdentity: 'actual store/session/workspace',
    explicit: () => ({}),
    registry: () => registry,
  };
  try {
    const expectedReadSet = readMcpSelection(base).readSet;
    let calls = 0;
    expect(() =>
      updateMcpSelection({
        ...base,
        registry: () => {
          if (++calls === 2) registry.revision = '2';
          return registry;
        },
        scope: 'user',
        serverId: 'one',
        enabled: false,
        expectedReadSet,
      }),
    ).toThrow('configuration_read_set_conflict');
    expect(calls).toBe(2);
    expect(readFileSync(userPath, 'utf8')).toBe(original);
    registry.revision = '1';
    calls = 0;
    expect(() =>
      updateMcpSelection({
        ...base,
        registry: () => {
          if (++calls === 2) writeFileSync(workspacePath, '{// SAME TARGET ETAG\n"mcp":[]}');
          return registry;
        },
        scope: 'user',
        serverId: 'one',
        enabled: false,
        expectedReadSet,
      }),
    ).toThrow('configuration_read_set_conflict');
    expect(readFileSync(userPath, 'utf8')).toBe(original);
    const fresh = readMcpSelection(base).readSet;
    const saved = updateMcpSelection({
      ...base,
      scope: 'user',
      serverId: 'one',
      enabled: false,
      expectedReadSet: fresh,
    });
    expect(saved.value).toMatchObject({
      unknown: { exact: 7 },
      mcp: [{ id: 'one', unknown: true, enabled: false }],
    });
    expect(readFileSync(userPath, 'utf8')).toContain('// KEEP');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
