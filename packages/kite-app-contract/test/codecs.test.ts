import { describe, expect, test } from 'bun:test';
import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  EXECUTION_STATUS_REQUEST_SCHEMA_,
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type ExecutionStatusRequest,
  type ExecutionStatusSnapshot,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  KITE_APP_CONTRACT_REVISION_,
  MCP_ACTION_REQUEST_SCHEMA_,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_REQUEST_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSnapshot,
  type ProviderModelSnapshotRequest,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  type ReleaseStatusRequest,
  type ReleaseStatusSnapshot,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  SKILL_CATALOG_REQUEST_SCHEMA_,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  type SkillCatalogRequest,
  type SkillCatalogSnapshot,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '../src';

const workspace = {
  canonicalPath: '/tmp/kite-project',
  projectId: 'project_1234',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} as const;

const revision = 'revision-1';
const externalReadScope = {
  roots: ['/tmp/kite-primary/.git'],
  digest: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
} as const;

const trustQueryRequest: WorkspaceTrustQueryRequest = {
  schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  workspace: '/tmp/kite-project',
};

const trustQueryResponse: WorkspaceTrustQueryResponse = {
  schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  workspace,
  status: 'unknown',
  revision,
  canDecide: true,
  externalReadScope,
};

const trustDecisionRequest: WorkspaceTrustDecisionRequest = {
  schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  workspace,
  observedStatus: 'unknown',
  expectedRevision: revision,
  decision: 'trust',
  externalReadScopeDigest: externalReadScope.digest,
};

const trustDecisionResponse: WorkspaceTrustDecisionResponse = {
  schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  workspace,
  status: 'trusted',
  outcome: 'recorded',
  revision,
  externalReadScope,
};

const providerSnapshot: ProviderModelSnapshot = {
  schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  workspace,
  revision,
  providers: [
    {
      provider: 'deepseek',
      type: 'deepseek',
      readiness: 'ready',
      selectedModel: 'deepseek-v4-flash',
      models: [
        {
          provider: 'deepseek',
          name: 'deepseek-v4-flash',
          isDefault: true,
          contextWindowTokens: 128_000,
          maxOutputTokens: 8_192,
          reasoning: true,
          streaming: true,
        },
      ],
    },
  ],
  selected: { provider: 'deepseek', name: 'deepseek-v4-flash' },
};

const mcpSnapshot: AppMcpSnapshot = {
  schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  workspace,
  revision,
  sourceRevisions: { project: 'project-1', user: 'user-1' },
  servers: [
    {
      key: { name: 'docs', source: 'user' },
      effective: true,
      sourcePath: '/home/test/.kite-code/mcp.json',
      transport: 'http',
      enabled: true,
      required: false,
      configStatus: 'ready',
      health: 'ready',
      authStatus: 'not_required',
      configuration: { endpoint: 'https://example.com' },
      revision: 'server-revision-1',
      toolCount: 1,
      resourceCount: 0,
      promptCount: 0,
      tools: [
        {
          name: 'search',
          description: 'Search documentation.',
          parameters: [{ name: 'query', type: 'string', required: true }],
          discovered: true,
        },
      ],
      prompts: [
        {
          name: 'lookup',
          description: 'Look up documentation.',
          arguments: [{ name: 'query', required: true }],
        },
      ],
    },
  ],
};

const mcpActionRequestFixture: AppMcpActionRequest = {
  schema: MCP_ACTION_REQUEST_SCHEMA_,
  workspace,
  action: {
    type: 'set_enabled',
    key: { name: 'docs', source: 'user' },
    enabled: false,
    expectedRevision: revision,
  },
};

const releaseStatus: ReleaseStatusSnapshot = {
  schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
  revision,
  active: true,
  production: false,
  profile: { id: 'internal-dogfood', channel: 'development' },
  capabilities: [
    {
      capability: 'runtime',
      maturity: 'stable',
      rollout: 'general',
      enabled: true,
      disabledReasons: [],
    },
  ],
  execution: { admitted: false },
  logging: { defaultMode: 'metadata', contentOptInAllowed: false },
  telemetry: { allowed: false },
  data: { providerRouteCount: 1 },
  verification: { requirement: 'not_required' },
};

describe('Kite App Contract', () => {
  test('publishes one fixed revision and exact route schemas', () => {
    expect(KITE_APP_CONTRACT_REVISION_).toBe('kite-app-contract-v1');
    expect(workspaceTrustQueryRequestCodec.schema).toBe(WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_);
    expect(workspaceTrustQueryResponseCodec.schema).toBe(WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_);
    expect(providerModelSnapshotRequestCodec.schema).toBe(PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_);
    expect(providerModelSnapshotResponseCodec.schema).toBe(
      PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    );
    expect(mcpSnapshotRequestCodec.schema).toBe(MCP_SNAPSHOT_REQUEST_SCHEMA_);
    expect(mcpSnapshotResponseCodec.schema).toBe(MCP_SNAPSHOT_RESPONSE_SCHEMA_);
    expect(skillCatalogRequestCodec.schema).toBe(SKILL_CATALOG_REQUEST_SCHEMA_);
    expect(skillCatalogResponseCodec.schema).toBe(SKILL_CATALOG_RESPONSE_SCHEMA_);
    expect(executionStatusRequestCodec.schema).toBe(EXECUTION_STATUS_REQUEST_SCHEMA_);
    expect(executionStatusResponseCodec.schema).toBe(EXECUTION_STATUS_RESPONSE_SCHEMA_);
    expect(releaseStatusRequestCodec.schema).toBe(RELEASE_STATUS_REQUEST_SCHEMA_);
    expect(releaseStatusResponseCodec.schema).toBe(RELEASE_STATUS_RESPONSE_SCHEMA_);
  });

  test('round-trips every current App Control DTO', () => {
    expect(
      workspaceTrustQueryRequestCodec.decode(
        workspaceTrustQueryRequestCodec.encode(trustQueryRequest),
      ),
    ).toEqual(trustQueryRequest);
    expect(
      workspaceTrustQueryResponseCodec.decode(
        workspaceTrustQueryResponseCodec.encode(trustQueryResponse),
      ),
    ).toEqual(trustQueryResponse);
    expect(
      workspaceTrustDecisionRequestCodec.decode(
        workspaceTrustDecisionRequestCodec.encode(trustDecisionRequest),
      ),
    ).toEqual(trustDecisionRequest);
    expect(
      workspaceTrustDecisionResponseCodec.decode(
        workspaceTrustDecisionResponseCodec.encode(trustDecisionResponse),
      ),
    ).toEqual(trustDecisionResponse);

    const providerRequest: ProviderModelSnapshotRequest = {
      schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
      workspace,
    };
    const providerSelectRequest: ProviderModelSelectRequest = {
      schema: PROVIDER_MODEL_SELECT_REQUEST_SCHEMA_,
      workspace,
      provider: 'deepseek',
      name: 'deepseek-v4-flash',
      expectedRevision: revision,
    };
    const providerSelectResponse: ProviderModelSelectResponse = {
      schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
      outcome: 'applied',
      snapshot: providerSnapshot,
    };
    expect(
      providerModelSnapshotRequestCodec.decode(
        providerModelSnapshotRequestCodec.encode(providerRequest),
      ),
    ).toEqual(providerRequest);
    expect(
      providerModelSnapshotResponseCodec.decode(
        providerModelSnapshotResponseCodec.encode(providerSnapshot),
      ),
    ).toEqual(providerSnapshot);
    expect(
      providerModelSelectRequestCodec.decode(
        providerModelSelectRequestCodec.encode(providerSelectRequest),
      ),
    ).toEqual(providerSelectRequest);
    expect(
      providerModelSelectResponseCodec.decode(
        providerModelSelectResponseCodec.encode(providerSelectResponse),
      ),
    ).toEqual(providerSelectResponse);

    const mcpRequest = {
      schema: MCP_SNAPSHOT_REQUEST_SCHEMA_,
      workspace,
    } as const;
    const mcpActionResponse: AppMcpActionResponse = {
      schema: MCP_ACTION_RESPONSE_SCHEMA_,
      outcome: 'applied',
      snapshot: mcpSnapshot,
    };
    expect(mcpSnapshotRequestCodec.decode(mcpSnapshotRequestCodec.encode(mcpRequest))).toEqual(
      mcpRequest,
    );
    expect(mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(mcpSnapshot))).toEqual(
      mcpSnapshot,
    );
    expect(
      mcpActionRequestCodec.decode(mcpActionRequestCodec.encode(mcpActionRequestFixture)),
    ).toEqual(mcpActionRequestFixture);
    expect(mcpActionResponseCodec.decode(mcpActionResponseCodec.encode(mcpActionResponse))).toEqual(
      mcpActionResponse,
    );

    const skillRequest: SkillCatalogRequest = {
      schema: SKILL_CATALOG_REQUEST_SCHEMA_,
      workspace,
    };
    const skillResponse: SkillCatalogSnapshot = {
      schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
      workspace,
      revision,
      skills: [
        {
          name: 'review',
          description: 'Review changed files.',
          source: 'user',
          origin: '.agents',
          status: 'available',
        },
      ],
    };
    expect(skillCatalogRequestCodec.decode(skillCatalogRequestCodec.encode(skillRequest))).toEqual(
      skillRequest,
    );
    expect(
      skillCatalogResponseCodec.decode(skillCatalogResponseCodec.encode(skillResponse)),
    ).toEqual(skillResponse);

    const executionRequest: ExecutionStatusRequest = {
      schema: EXECUTION_STATUS_REQUEST_SCHEMA_,
      workspace,
    };
    const executionResponse: ExecutionStatusSnapshot = {
      schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
      workspace,
      revision,
      admitted: false,
      sandboxBackend: 'none',
      filesystemScope: 'none',
      networkMode: 'off',
      controllerWorktreeActive: false,
    };
    const releaseRequest: ReleaseStatusRequest = {
      schema: RELEASE_STATUS_REQUEST_SCHEMA_,
    };
    expect(
      executionStatusRequestCodec.decode(executionStatusRequestCodec.encode(executionRequest)),
    ).toEqual(executionRequest);
    expect(
      executionStatusResponseCodec.decode(executionStatusResponseCodec.encode(executionResponse)),
    ).toEqual(executionResponse);
    expect(
      releaseStatusRequestCodec.decode(releaseStatusRequestCodec.encode(releaseRequest)),
    ).toEqual(releaseRequest);
    expect(
      releaseStatusResponseCodec.decode(releaseStatusResponseCodec.encode(releaseStatus)),
    ).toEqual(releaseStatus);
  });

  test('decodes legacy Workspace Trust v1 payloads as an empty external scope', () => {
    const emptyScope = {
      roots: [],
      digest: 'sha256:091d69962ffd218c877f4a68f168523d50da8287b50964f5c7345ed62c0a643a',
    };
    expect(
      workspaceTrustQueryResponseCodec.decode({
        schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
        workspace,
        status: 'unknown',
        revision,
        canDecide: true,
      }),
    ).toMatchObject({ externalReadScope: emptyScope });
    expect(
      workspaceTrustDecisionRequestCodec.decode({
        schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
        workspace,
        observedStatus: 'unknown',
        expectedRevision: revision,
        decision: 'trust',
      }),
    ).toMatchObject({ externalReadScopeDigest: emptyScope.digest });
    expect(
      workspaceTrustDecisionResponseCodec.decode({
        schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
        workspace,
        status: 'trusted',
        outcome: 'recorded',
        revision,
      }),
    ).toMatchObject({ externalReadScope: emptyScope });
  });

  test('rejects unknown fields at every route boundary', () => {
    expect(() =>
      workspaceTrustQueryRequestCodec.decode({ ...trustQueryRequest, extra: true }),
    ).toThrow();
    expect(() =>
      workspaceTrustQueryResponseCodec.decode({
        ...trustQueryResponse,
        workspace: { ...workspace, extra: true },
      }),
    ).toThrow();
    expect(() =>
      providerModelSnapshotResponseCodec.decode({
        ...providerSnapshot,
        providers: [{ ...providerSnapshot.providers[0], apiKey: 'secret' }],
      }),
    ).toThrow();
    expect(() =>
      mcpSnapshotResponseCodec.decode({
        ...mcpSnapshot,
        servers: [{ ...mcpSnapshot.servers[0], endpoint: 'http://127.0.0.1' }],
      }),
    ).toThrow();
    expect(() =>
      mcpActionRequestCodec.decode({
        ...mcpActionRequestFixture,
        action: { ...mcpActionRequestFixture.action, dynamicMethod: 'remove' },
      }),
    ).toThrow();
    expect(() =>
      skillCatalogResponseCodec.decode({
        ...{
          schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
          workspace,
          revision,
          skills: [
            {
              name: 'x',
              description: '',
              source: 'user',
              origin: '.agents',
              status: 'available',
              extra: 1,
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      executionStatusResponseCodec.decode({
        ...{
          schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
          workspace,
          revision,
          admitted: false,
          sandboxBackend: 'none',
          filesystemScope: 'none',
          networkMode: 'off',
          controllerWorktreeActive: false,
          pid: 1,
        },
      }),
    ).toThrow();
    expect(() => releaseStatusResponseCodec.decode({ ...releaseStatus, buildId: 'dev' })).toThrow();
  });

  test('rejects malformed identity and unsafe unbounded values', () => {
    expect(() =>
      workspaceTrustQueryResponseCodec.decode({
        ...trustQueryResponse,
        workspace: { ...workspace, workspaceDigest: 'not-a-digest' },
      }),
    ).toThrow();
    expect(() =>
      providerModelSnapshotResponseCodec.decode({
        ...providerSnapshot,
        providers: providerSnapshot.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, name: '' })),
        })),
      }),
    ).toThrow();
    expect(() =>
      mcpActionRequestCodec.decode({
        ...mcpActionRequestFixture,
        action: {
          type: 'add',
          source: 'user',
          name: 'docs',
          transport: 'http',
          value: '',
          expectedRevision: revision,
        },
      }),
    ).toThrow();
    expect(() =>
      mcpSnapshotResponseCodec.decode({
        ...mcpSnapshot,
        servers: [
          {
            ...mcpSnapshot.servers[0],
            configuration: { endpoint: 'https://example.com/mcp?token=secret' },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      mcpSnapshotResponseCodec.decode({
        ...mcpSnapshot,
        servers: [{ ...mcpSnapshot.servers[0], credential: 'secret' }],
      }),
    ).toThrow();
  });
});
