import {
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import { resolveProjectIdentity } from '@kite-ai/runtime-host';
import { getWorkspaceTrustSnapshot, trustWorkspace } from '#kite-service/config/workspace-trust';
import type { WorkspaceTrustHandlerPort as AppWorkspaceTrustHandlerPort } from '../ports';

function query(workspace: string, storePath?: string): WorkspaceTrustQueryResponse {
  const snapshot = getWorkspaceTrustSnapshot(workspace, storePath);
  if (!snapshot) {
    throw new Error('Workspace identity is unavailable.');
  }
  const project = resolveProjectIdentity(snapshot.canonicalPath);
  return {
    schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
    workspace: {
      canonicalPath: snapshot.canonicalPath,
      projectId: project.projectId,
      workspaceDigest: project.workspaceDigest,
    },
    status: snapshot.status,
    revision: snapshot.revision,
    canDecide: snapshot.status === 'unknown' || snapshot.status === 'trusted',
    externalReadScope: snapshot.externalReadScope,
  };
}

/** Process-wide trust owner. It canonicalizes before project config can be loaded. */
export function createWorkspaceTrustOwner(
  input: { readonly storePath?: string } = {},
): AppWorkspaceTrustHandlerPort {
  return Object.freeze({
    async query(request: WorkspaceTrustQueryRequest): Promise<WorkspaceTrustQueryResponse> {
      return query(request.workspace, input.storePath);
    },
    async decide(request: WorkspaceTrustDecisionRequest): Promise<WorkspaceTrustDecisionResponse> {
      const current = query(request.workspace.canonicalPath, input.storePath);
      if (
        current.workspace.projectId !== request.workspace.projectId ||
        current.workspace.workspaceDigest !== request.workspace.workspaceDigest ||
        current.externalReadScope.digest !== request.externalReadScopeDigest
      ) {
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace: current.workspace,
          status: current.status,
          outcome: 'conflict',
          revision: current.revision,
          externalReadScope: current.externalReadScope,
        };
      }
      if (request.decision === 'decline') {
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace: current.workspace,
          status: current.status,
          outcome: 'declined',
          revision: current.revision,
          externalReadScope: current.externalReadScope,
        };
      }
      if (
        current.status === 'trusted' &&
        current.status === request.observedStatus &&
        current.revision === request.expectedRevision
      ) {
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace: current.workspace,
          status: current.status,
          outcome: 'already_trusted',
          revision: current.revision,
          externalReadScope: current.externalReadScope,
        };
      }
      if (
        current.status !== request.observedStatus ||
        current.revision !== request.expectedRevision
      ) {
        return {
          schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
          workspace: current.workspace,
          status: current.status,
          outcome: 'conflict',
          revision: current.revision,
          externalReadScope: current.externalReadScope,
        };
      }
      const result = trustWorkspace({
        workspace: current.workspace.canonicalPath,
        source: 'user',
        ...(input.storePath === undefined ? {} : { storePath: input.storePath }),
        expectedRevision: request.expectedRevision,
      });
      const updated = query(current.workspace.canonicalPath, input.storePath);
      return {
        schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
        workspace: updated.workspace,
        status: updated.status,
        outcome:
          result.status === 'recorded'
            ? 'recorded'
            : result.status === 'conflict'
              ? 'conflict'
              : 'unavailable',
        revision: updated.revision,
        externalReadScope: updated.externalReadScope,
      };
    },
  });
}
