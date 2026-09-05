import { describe, expect, test } from 'bun:test';
import type {
  AppMcpAction,
  AppMcpActionResponse,
  AppMcpServer,
  AppMcpServerKey,
  AppMcpSnapshot,
  KiteAppControlClient,
  KiteWorkspaceIdentity,
} from '@kite-ai/kite-app-contract';
import { TuiMcpController } from '#kite-cli/tui/mcp/controller';

const workspace: KiteWorkspaceIdentity = Object.freeze({
  canonicalPath: '/workspace',
  projectId: 'project_test',
  workspaceDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
});

function makeServer(overrides: Partial<AppMcpServer> = {}): AppMcpServer {
  return {
    key: { name: 'github', source: 'project' },
    effective: true,
    sourcePath: '/workspace/.kite-code/mcp.json',
    transport: 'http',
    enabled: true,
    required: false,
    configStatus: 'ready',
    health: 'ready',
    authStatus: 'not_required',
    configuration: { endpoint: 'https://example.com' },
    revision: 'server-1',
    toolCount: 0,
    resourceCount: 0,
    promptCount: 0,
    tools: [],
    prompts: [],
    ...overrides,
  };
}

function makeSnapshot(servers: readonly AppMcpServer[] = []): AppMcpSnapshot {
  return {
    schema: 'kite.app.mcp.snapshot-response.v1',
    workspace,
    revision: 'snapshot-1',
    sourceRevisions: { project: 'project-1', user: 'user-1' },
    sourcePaths: {
      project: '/workspace/.kite-code/mcp.json',
      user: '/home/user/.kite-code/mcp.json',
    },
    servers,
  };
}

function createClient(initial = makeSnapshot()) {
  let snapshot = initial;
  const requests: AppMcpAction[] = [];
  const client = {
    async getMcpSnapshot() {
      return snapshot;
    },
    async applyMcpAction(request: { action: AppMcpAction }): Promise<AppMcpActionResponse> {
      requests.push(request.action);
      return {
        schema: 'kite.app.mcp.action-response.v1',
        outcome: 'applied',
        snapshot,
      };
    },
    setSnapshot(next: AppMcpSnapshot) {
      snapshot = next;
    },
    requests,
  } as unknown as KiteAppControlClient & {
    setSnapshot(next: AppMcpSnapshot): void;
    requests: AppMcpAction[];
  };
  return client;
}

describe('TuiMcpController', () => {
  test('does not republish an unchanged polled revision', async () => {
    const client = createClient();
    const controller = new TuiMcpController(client, workspace);
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    try {
      await controller.start();
      await Bun.sleep(600);
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      await controller.stop();
    }
  });

  test('loads the safe App Control snapshot and preserves workspace identity', async () => {
    const client = createClient();
    const controller = new TuiMcpController(client, workspace);

    await controller.start();

    expect(controller.getSnapshot().control.workspace).toEqual(workspace);
    expect(controller.getSnapshot().control.servers).toEqual([]);
  });

  test('maps visible mutations to exact App Control actions', async () => {
    const server = makeServer({
      key: { name: 'github', source: 'project' },
      revision: 'server-revision',
    });
    const client = createClient(makeSnapshot([server]));
    const controller = new TuiMcpController(client, workspace);
    await controller.start();

    await controller.setEnabled(server.key, 'server-revision', false);
    await controller.remove(server.key, 'server-revision');
    await controller.add({
      scope: 'project',
      name: 'docs',
      config: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });

    expect(client.requests).toEqual([
      {
        type: 'set_enabled',
        key: server.key,
        expectedRevision: 'server-revision',
        enabled: false,
      },
      { type: 'remove', key: server.key, expectedRevision: 'server-revision' },
      {
        type: 'add',
        source: 'project',
        name: 'docs',
        transport: 'http',
        value: 'https://mcp.example.com/mcp',
        expectedRevision: 'project-1',
      },
    ]);
  });

  test('resolves authentication cancellation by safe flow id', async () => {
    const server = makeServer({
      authStatus: 'authorizing',
      authFlowId: 'flow-1',
      revision: 'auth-revision',
    });
    const client = createClient(makeSnapshot([server]));
    const controller = new TuiMcpController(client, workspace);
    await controller.start();

    await controller.cancelAuth('flow-1');

    expect(client.requests).toEqual([
      { type: 'cancel_auth', key: server.key, expectedRevision: 'auth-revision' },
    ]);
  });

  test('does not retry an outcome_unknown mutation', async () => {
    const server = makeServer({ revision: 'server-revision' });
    const client = createClient(makeSnapshot([server]));
    client.applyMcpAction = async (request: { action: AppMcpAction }) => {
      client.requests.push(request.action);
      return {
        schema: 'kite.app.mcp.action-response.v1',
        outcome: 'outcome_unknown',
        snapshot: makeSnapshot([server]),
      };
    };
    const controller = new TuiMcpController(client, workspace);
    await controller.start();

    expect(await controller.retry(server.key)).toBe(false);
    expect(client.requests).toHaveLength(1);
    expect(controller.getSnapshot().message).toContain('outcome_unknown');
  });

  test('preserves a mutation result across the next background snapshot refresh', async () => {
    const server = makeServer({ revision: 'server-revision' });
    const snapshot = makeSnapshot([server]);
    let reads = 0;
    let observePoll!: () => void;
    const polled = new Promise<void>((resolve) => {
      observePoll = resolve;
    });
    const client = createClient(snapshot);
    client.getMcpSnapshot = async () => {
      reads += 1;
      if (reads === 2) observePoll();
      return snapshot;
    };
    const controller = new TuiMcpController(client, workspace);
    await controller.start();

    expect(await controller.retry(server.key)).toBe(true);
    await polled;
    expect(controller.getSnapshot().message).toBe('Retried MCP server github.');

    await controller.stop();
  });

  test('rejects mutations for a server that is no longer in the snapshot', async () => {
    const client = createClient();
    const controller = new TuiMcpController(client, workspace);
    await controller.start();

    const missing: AppMcpServerKey = { name: 'missing', source: 'project' };
    expect(await controller.retry(missing)).toBe(false);
    expect(client.requests).toHaveLength(0);
  });
});
