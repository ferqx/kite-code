import { describe, expect, test } from 'bun:test';
import {
  EXECUTION_STATUS_REQUEST_SCHEMA_,
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type KiteAppControlClient,
  MCP_ACTION_REQUEST_SCHEMA_,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_REQUEST_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  SKILL_CATALOG_REQUEST_SCHEMA_,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createInProcessKiteAppControlClient } from '../src/app-control/in-process';

const workspace = {
  canonicalPath: '/tmp/kite-app-control',
  projectId: 'project_test',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as const;
const revision = 'revision-1';

function fakeService(observed: string[]): KiteAppControlClient {
  return {
    async queryWorkspaceTrust(request) {
      observed.push('trust.query');
      return {
        schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
        workspace,
        status: 'unknown',
        revision,
        canDecide: request.workspace === workspace.canonicalPath,
      };
    },
    async decideWorkspaceTrust(request) {
      observed.push('trust.decide');
      return {
        schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
        workspace: request.workspace,
        status: request.decision === 'trust' ? 'trusted' : request.observedStatus,
        outcome: request.decision === 'trust' ? 'recorded' : 'declined',
        revision: 'revision-2',
      };
    },
    async getProviderModelSnapshot() {
      observed.push('provider.snapshot');
      return {
        schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
        workspace,
        revision,
        providers: [],
      };
    },
    async selectProviderModel() {
      observed.push('provider.select');
      return {
        schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
        outcome: 'unavailable',
        snapshot: {
          schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
          workspace,
          revision,
          providers: [],
        },
      };
    },
    async getMcpSnapshot() {
      observed.push('mcp.snapshot');
      return {
        schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
        workspace,
        revision,
        sourceRevisions: { project: revision, user: revision },
        servers: [],
      };
    },
    async applyMcpAction() {
      observed.push('mcp.action');
      return {
        schema: MCP_ACTION_RESPONSE_SCHEMA_,
        outcome: 'applied',
        snapshot: {
          schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
          workspace,
          revision: 'revision-2',
          sourceRevisions: { project: revision, user: 'revision-2' },
          servers: [],
        },
      };
    },
    async getSkillCatalog() {
      observed.push('skills.snapshot');
      return {
        schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
        workspace,
        revision,
        skills: [],
      };
    },
    async getExecutionStatus() {
      observed.push('execution.status');
      return {
        schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
        workspace,
        revision,
        admitted: false,
        sandboxBackend: 'none',
        filesystemScope: 'none',
        networkMode: 'off',
        controllerWorktreeActive: false,
      };
    },
    async getReleaseStatus() {
      observed.push('release.status');
      return {
        schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
        revision,
        active: false,
        production: false,
        capabilities: [],
        execution: { admitted: false },
      };
    },
  };
}

describe('InProcess Kite App Control client', () => {
  test('round-trips every current exact use case without a Manager passthrough', async () => {
    const observed: string[] = [];
    const client = createInProcessKiteAppControlClient(fakeService(observed));

    const trust = await client.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: workspace.canonicalPath,
    });
    await client.decideWorkspaceTrust({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
    });
    await client.getProviderModelSnapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace,
    });
    await client.selectProviderModel({
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace,
      provider: 'deepseek',
      name: 'deepseek-chat',
      expectedRevision: revision,
    });
    await client.getMcpSnapshot({ schema: MCP_SNAPSHOT_REQUEST_SCHEMA_, workspace });
    await client.applyMcpAction({
      schema: MCP_ACTION_REQUEST_SCHEMA_,
      workspace,
      action: {
        type: 'set_enabled',
        key: { name: 'docs', source: 'user' },
        enabled: false,
        expectedRevision: revision,
      },
    });
    await client.getSkillCatalog({ schema: SKILL_CATALOG_REQUEST_SCHEMA_, workspace });
    await client.getExecutionStatus({ schema: EXECUTION_STATUS_REQUEST_SCHEMA_, workspace });
    await client.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ });

    expect(observed).toEqual([
      'trust.query',
      'trust.decide',
      'provider.snapshot',
      'provider.select',
      'mcp.snapshot',
      'mcp.action',
      'skills.snapshot',
      'execution.status',
      'release.status',
    ]);
    expect('call' in client).toBe(false);
  });

  test('rejects an unchecked service response before it reaches the client', async () => {
    const service = fakeService([]);
    service.getReleaseStatus = async () =>
      ({
        schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
        revision,
        active: false,
        production: false,
        capabilities: [],
        execution: { admitted: false },
        manager: 'forbidden',
      }) as never;
    const client = createInProcessKiteAppControlClient(service);
    await expect(
      client.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ }),
    ).rejects.toThrow();
  });
});
