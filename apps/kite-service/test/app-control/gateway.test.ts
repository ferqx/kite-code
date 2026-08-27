import { describe, expect, test } from 'bun:test';
import {
  type KiteWorkspaceIdentity,
  PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  RELEASE_STATUS_REQUEST_SCHEMA_,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  createInProcessAppControlGateway,
  createSerialAppControlOperationGate,
} from '../../src/app-control';

const WORKSPACE: KiteWorkspaceIdentity = {
  canonicalPath: '/workspace/gateway',
  projectId: 'gateway-project',
  workspaceDigest: `sha256:${'a'.repeat(64)}`,
};
const EXTERNAL_READ_SCOPE = { roots: [], digest: `sha256:${'0'.repeat(64)}` as const };

describe('InProcess App Control gateway', () => {
  test('boots discovery without Workspace dependencies and binds them only after admission', async () => {
    let workspaceCompositions = 0;
    const gateway = createInProcessAppControlGateway({
      operationGate: createSerialAppControlOperationGate(),
      workspaceTrust: {
        query: async () => ({
          schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
          workspace: WORKSPACE,
          status: 'trusted',
          revision: 'trust-1',
          canDecide: false,
          externalReadScope: EXTERNAL_READ_SCOPE,
        }),
        decide: async () => {
          throw new Error('unused');
        },
      },
      release: {
        snapshot: async () => ({
          schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
          revision: 'release-1',
          active: false,
          production: false,
          capabilities: [],
          execution: { admitted: false },
        }),
      },
      createWorkspaceHandlers: (workspace) => {
        workspaceCompositions += 1;
        const unused = async (): Promise<never> => {
          throw new Error('unused');
        };
        return {
          providerModel: {
            snapshot: async () => ({
              schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
              workspace,
              revision: 'provider-1',
              providers: [],
            }),
            select: unused,
          },
          mcp: { snapshot: unused, apply: unused },
          skills: { snapshot: unused },
          execution: { snapshot: unused },
        };
      },
    });

    await expect(
      gateway.discovery.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace: WORKSPACE.canonicalPath,
      }),
    ).resolves.toMatchObject({ status: 'trusted' });
    await expect(
      gateway.discovery.getReleaseStatus({ schema: RELEASE_STATUS_REQUEST_SCHEMA_ }),
    ).resolves.toMatchObject({ revision: 'release-1' });
    expect(workspaceCompositions).toBe(0);
    await expect(
      gateway.discovery.getProviderModelSnapshot({
        schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: WORKSPACE,
      }),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });

    const workspaceClient = gateway.forWorkspace(WORKSPACE);
    await expect(
      workspaceClient.getProviderModelSnapshot({
        schema: PROVIDER_MODEL_SNAPSHOT_REQUEST_SCHEMA_,
        workspace: WORKSPACE,
      }),
    ).resolves.toMatchObject({ revision: 'provider-1' });
    expect(workspaceCompositions).toBe(1);
    expect(gateway.forWorkspace(WORKSPACE)).toBe(workspaceClient);
    await expect(
      workspaceClient.decideWorkspaceTrust({
        schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
        workspace: { ...WORKSPACE, projectId: 'other-project' },
        observedStatus: 'unknown',
        expectedRevision: 'trust-1',
        decision: 'trust',
        externalReadScopeDigest: EXTERNAL_READ_SCOPE.digest,
      }),
    ).rejects.toMatchObject({ code: 'invalid_app_control_request' });
  });
});
