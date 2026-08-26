import { describe, expect, test } from 'bun:test';
import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  EXECUTION_STATUS_REQUEST_SCHEMA_,
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type ExecutionStatusSnapshot,
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
  MCP_ACTION_REQUEST_SCHEMA_,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_REQUEST_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSnapshot,
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  type ReleaseStatusSnapshot,
  SKILL_CATALOG_REQUEST_SCHEMA_,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  type SkillCatalogSnapshot,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  createExecutionStatusHandler,
  createInProcessKiteAppControlClient,
  createKiteAppControlService,
  createMcpHandler,
  createProviderModelHandler,
  createReleaseStatusHandler,
  createSerialAppControlOperationGate,
  createSkillCatalogHandler,
  createWorkspaceTrustHandler,
  type KiteAppControlHandlerPorts,
} from '../../src/app-control';

const WORKSPACE_A = {
  canonicalPath: '/tmp/kite-app-control-a',
  projectId: 'project_a',
  workspaceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

const WORKSPACE_B = {
  canonicalPath: '/tmp/kite-app-control-b',
  projectId: 'project_b',
  workspaceDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
} as const;

function providerSnapshot(
  workspace: KiteWorkspaceIdentity,
  revision: string,
  selected = 'model',
): ProviderModelSnapshot {
  return {
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision,
    providers: [
      {
        provider: 'openai',
        type: 'openai',
        readiness: 'ready',
        selectedModel: selected,
        models: [
          {
            provider: 'openai',
            name: selected,
            isDefault: true,
            contextWindowTokens: 128_000,
            maxOutputTokens: 8_192,
            reasoning: true,
            streaming: true,
          },
        ],
      },
    ],
    selected: { provider: 'openai', name: selected },
  };
}

function mcpSnapshot(workspace: KiteWorkspaceIdentity, revision: string): AppMcpSnapshot {
  return {
    schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision,
    sourceRevisions: { project: `${revision}-project`, user: `${revision}-user` },
    servers: [],
  };
}

function executionSnapshot(
  workspace: KiteWorkspaceIdentity,
  revision: string,
): ExecutionStatusSnapshot {
  return {
    schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
    workspace,
    revision,
    admitted: true,
    sandboxBackend: 'none',
    filesystemScope: 'workspace_write',
    networkMode: 'off',
    controllerWorktreeActive: false,
  };
}

function releaseSnapshot(revision: string): ReleaseStatusSnapshot {
  return {
    schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
    revision,
    active: true,
    production: false,
    profile: { id: 'development', channel: 'development' },
    capabilities: [],
    execution: { admitted: false },
  };
}

interface HandlerFixture {
  readonly handlers: KiteAppControlHandlerPorts;
  readonly calls: string[];
  readonly expectedRevisions: string[];
}

function handlerFixture(
  label: string,
  workspace: KiteWorkspaceIdentity,
  providerSelectionOutcome: ProviderModelSelectResponse['outcome'] = 'applied',
): HandlerFixture {
  const calls: string[] = [];
  const expectedRevisions: string[] = [];
  const raw = {
    workspaceTrust: {
      async query(): Promise<WorkspaceTrustQueryResponse> {
        calls.push(`${label}:trust.query`);
        return {
          schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
          workspace,
          status: 'unknown',
          revision: `${label}-trust-1`,
          canDecide: true,
        };
      },
      async decide(
        request: WorkspaceTrustDecisionRequest,
      ): Promise<WorkspaceTrustDecisionResponse> {
        calls.push(`${label}:trust.decide`);
        expectedRevisions.push(request.expectedRevision);
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace: request.workspace,
          status: request.decision === 'trust' ? 'trusted' : 'unknown',
          outcome: request.decision === 'trust' ? 'recorded' : 'declined',
          revision: `${label}-trust-2`,
        };
      },
    },
    providerModel: {
      async snapshot(): Promise<ProviderModelSnapshot> {
        calls.push(`${label}:provider.snapshot`);
        return providerSnapshot(workspace, `${label}-provider-1`);
      },
      async select(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse> {
        calls.push(`${label}:provider.select`);
        expectedRevisions.push(request.expectedRevision);
        return {
          schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
          outcome: providerSelectionOutcome,
          snapshot: providerSnapshot(workspace, `${label}-provider-2`),
        };
      },
    },
    mcp: {
      async snapshot(): Promise<AppMcpSnapshot> {
        calls.push(`${label}:mcp.snapshot`);
        return mcpSnapshot(workspace, `${label}-mcp-1`);
      },
      async apply(request: AppMcpActionRequest): Promise<AppMcpActionResponse> {
        calls.push(`${label}:mcp.apply`);
        expectedRevisions.push(request.action.expectedRevision);
        return {
          schema: MCP_ACTION_RESPONSE_SCHEMA_,
          outcome: 'applied',
          snapshot: mcpSnapshot(workspace, `${label}-mcp-2`),
        };
      },
    },
    skills: {
      async snapshot(): Promise<SkillCatalogSnapshot> {
        calls.push(`${label}:skills.snapshot`);
        return {
          schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
          workspace,
          revision: `${label}-skills-1`,
          skills: [],
        };
      },
    },
    execution: {
      async snapshot(): Promise<ExecutionStatusSnapshot> {
        calls.push(`${label}:execution.snapshot`);
        return executionSnapshot(workspace, `${label}-execution-1`);
      },
    },
    release: {
      async snapshot(): Promise<ReleaseStatusSnapshot> {
        calls.push(`${label}:release.snapshot`);
        return releaseSnapshot(`${label}-release-1`);
      },
    },
  };

  return {
    calls,
    expectedRevisions,
    handlers: {
      workspaceTrust: createWorkspaceTrustHandler({ handler: raw.workspaceTrust, workspace }),
      providerModel: createProviderModelHandler({ handler: raw.providerModel, workspace }),
      mcp: createMcpHandler({ handler: raw.mcp, workspace }),
      skills: createSkillCatalogHandler({ handler: raw.skills, workspace }),
      execution: createExecutionStatusHandler({ handler: raw.execution, workspace }),
      release: createReleaseStatusHandler({ handler: raw.release }),
    },
  };
}

function serviceFixture(
  label: string,
  workspace: KiteWorkspaceIdentity,
  outcome: ProviderModelSelectResponse['outcome'] = 'applied',
) {
  const fixture = handlerFixture(label, workspace, outcome);
  const gate = createSerialAppControlOperationGate();
  return {
    ...fixture,
    service: createKiteAppControlService({
      workspace,
      operationGate: gate,
      handlers: fixture.handlers,
    }),
  };
}

describe('Kite App Control service', () => {
  test('routes every exact journey through independent handlers and gates mutations', async () => {
    const fixture = serviceFixture('a', WORKSPACE_A);
    const client = createInProcessKiteAppControlClient(fixture.service);

    const trust = await client.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A.canonicalPath,
    });
    await client.decideWorkspaceTrust({
      schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
      observedStatus: trust.status,
      expectedRevision: trust.revision,
      decision: 'trust',
    });
    await client.getProviderModelSnapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    await client.selectProviderModel({
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
      provider: 'openai',
      name: 'model',
      expectedRevision: 'provider-cas-1',
    });
    await client.getMcpSnapshot({
      schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    await client.applyMcpAction({
      schema: MCP_ACTION_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
      action: {
        type: 'set_enabled',
        key: { name: 'docs', source: 'user' },
        enabled: false,
        expectedRevision: 'mcp-cas-1',
      },
    });
    await client.getSkillCatalog({
      schema: SKILL_CATALOG_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    await client.getExecutionStatus({
      schema: EXECUTION_STATUS_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    await client.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ });

    expect(fixture.calls).toEqual([
      'a:trust.query',
      'a:trust.decide',
      'a:provider.snapshot',
      'a:provider.select',
      'a:mcp.snapshot',
      'a:mcp.apply',
      'a:skills.snapshot',
      'a:execution.snapshot',
      'a:release.snapshot',
    ]);
    expect(fixture.expectedRevisions).toEqual(['a-trust-1', 'provider-cas-1', 'mcp-cas-1']);
  });

  test('keeps two workspace handler sets isolated and rejects a cross-workspace request', async () => {
    const first = serviceFixture('first', WORKSPACE_A);
    const second = serviceFixture('second', WORKSPACE_B);

    await first.service.getProviderModelSnapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    await second.service.getProviderModelSnapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_B,
    });
    await expect(
      first.service.getMcpSnapshot({
        schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: WORKSPACE_B,
      }),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });

    expect(first.calls).toEqual(['first:provider.snapshot']);
    expect(second.calls).toEqual(['second:provider.snapshot']);
  });

  test('fails closed for workspace routes without connection admission', async () => {
    const fixture = handlerFixture('unbound', WORKSPACE_A);
    const service = createKiteAppControlService({
      operationGate: createSerialAppControlOperationGate(),
      handlers: fixture.handlers,
    });

    await expect(
      service.getProviderModelSnapshot({
        schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: WORKSPACE_A,
      }),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });
    await expect(
      service.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace: WORKSPACE_A.canonicalPath,
      }),
    ).resolves.toMatchObject({ workspace: WORKSPACE_A });
    await expect(
      service.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ }),
    ).resolves.toMatchObject({ schema: RELEASE_STATUS_RESPONSE_SCHEMA_ });
  });

  test('rejects a workspace-scoped handler response with different Project identity', async () => {
    const fixture = handlerFixture('wrong-response', WORKSPACE_A);
    const service = createKiteAppControlService({
      workspace: WORKSPACE_A,
      operationGate: createSerialAppControlOperationGate(),
      handlers: {
        ...fixture.handlers,
        skills: {
          async snapshot() {
            return {
              schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
              workspace: WORKSPACE_B,
              revision: 'wrong-workspace-response',
              skills: [],
            };
          },
        },
      },
    });

    await expect(
      service.getSkillCatalog({
        schema: SKILL_CATALOG_REQUEST_SCHEMA_,
        workspace: WORKSPACE_A,
      }),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });
  });

  test('preserves outcome_unknown and requires an explicit follow-up query without retrying', async () => {
    const fixture = serviceFixture('unknown', WORKSPACE_A, 'outcome_unknown');
    const client = createInProcessKiteAppControlClient(fixture.service);

    const response = await client.selectProviderModel({
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
      provider: 'openai',
      name: 'model',
      expectedRevision: 'provider-cas-unknown',
    });
    expect(response.outcome).toBe('outcome_unknown');
    expect(fixture.calls).toEqual(['unknown:provider.select']);

    await client.getProviderModelSnapshot({
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace: WORKSPACE_A,
    });
    expect(fixture.calls).toEqual(['unknown:provider.select', 'unknown:provider.snapshot']);
  });

  test('does not replay a mutation when the response is lost', async () => {
    const fixture = serviceFixture('lost', WORKSPACE_A);
    let attempts = 0;
    const serviceWithLostResponse: KiteAppControlClient = {
      queryWorkspaceTrust: fixture.service.queryWorkspaceTrust.bind(fixture.service),
      decideWorkspaceTrust: fixture.service.decideWorkspaceTrust.bind(fixture.service),
      getProviderModelSnapshot: fixture.service.getProviderModelSnapshot.bind(fixture.service),
      async selectProviderModel() {
        attempts += 1;
        throw new Error('response lost after mutation admission');
      },
      getMcpSnapshot: fixture.service.getMcpSnapshot.bind(fixture.service),
      applyMcpAction: fixture.service.applyMcpAction.bind(fixture.service),
      getSkillCatalog: fixture.service.getSkillCatalog.bind(fixture.service),
      getExecutionStatus: fixture.service.getExecutionStatus.bind(fixture.service),
      getReleaseStatus: fixture.service.getReleaseStatus.bind(fixture.service),
    };
    const client = createInProcessKiteAppControlClient(serviceWithLostResponse);

    await expect(
      client.selectProviderModel({
        schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
        workspace: WORKSPACE_A,
        provider: 'openai',
        name: 'model',
        expectedRevision: 'lost-cas-1',
      }),
    ).rejects.toThrow('response lost');
    expect(attempts).toBe(1);
  });
});
