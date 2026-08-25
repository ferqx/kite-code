import { describe, expect, test } from 'bun:test';
import type {
  McpAuthResult,
  McpControlSnapshot,
  McpRuntimeProvider,
  McpServerKey,
  McpSupervisor,
} from '@kite/builtin-runtime/mcp';
import { TuiMcpController } from '@/app/tui/mcp/controller';

function createSupervisor(): {
  supervisor: McpSupervisor;
  snapshot: McpControlSnapshot;
} {
  const listeners = new Set<() => void>();
  let snapshot: McpControlSnapshot = {
    revision: 'revision-1',
    generation: 1,
    servers: Object.freeze([]),
    sourceRevisions: Object.freeze({
      local: 'local-1',
      project: 'project-1',
      user: 'user-1',
    }),
  };
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const runtimeProvider = {} as McpRuntimeProvider;

  return {
    supervisor: {
      async start() {},
      async stop() {},
      async reload() {},
      async retry() {},
      async mutate() {
        snapshot = Object.freeze({
          revision: 'revision-2',
          generation: snapshot.generation + 1,
          servers: snapshot.servers,
          sourceRevisions: snapshot.sourceRevisions,
        });
        emit();
      },
      async remove() {
        snapshot = Object.freeze({
          ...snapshot,
          revision: 'revision-3',
          generation: snapshot.generation + 1,
        });
        emit();
        return { credentialCleanup: 'not_needed' };
      },
      async login(_key: McpServerKey): Promise<McpAuthResult> {
        return { status: 'connected' } as unknown as McpAuthResult;
      },
      async cancelAuth(_flowId: string): Promise<McpAuthResult> {
        return { status: 'connected' } as unknown as McpAuthResult;
      },
      async logout(_key: McpServerKey, _revoke: boolean): Promise<McpAuthResult> {
        return { status: 'connected' } as unknown as McpAuthResult;
      },
      getSnapshot() {
        return snapshot;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getRuntimeProvider() {
        return runtimeProvider;
      },
    },
    get snapshot() {
      return snapshot;
    },
  };
}

describe('TuiMcpController', () => {
  test('replaces stale remove message when adding a server', async () => {
    const { supervisor } = createSupervisor();
    const controller = new TuiMcpController(supervisor, '/workspace');

    await controller.remove({ name: 'test', source: 'project' }, 'project-1');
    expect(controller.getSnapshot().message).toBe('Removed MCP server test.');

    const added = await controller.add({
      scope: 'project',
      name: 'test',
      config: { type: 'http', url: 'https://example.com/mcp' },
    });
    expect(added).toEqual({ name: 'test', source: 'project' });
    expect(controller.getSnapshot().message).toBe('Added MCP server test.');
  });
});
