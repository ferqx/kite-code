import {
  type KiteWorkspaceIdentity,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';
import { assertSameWorkspace, type WorkspaceTrustHandlerPort } from './ports';

export interface WorkspaceTrustHandlerDependencies {
  readonly handler: WorkspaceTrustHandlerPort;
  readonly workspace?: KiteWorkspaceIdentity;
}

export function createWorkspaceTrustHandler(
  input: WorkspaceTrustHandlerDependencies,
): WorkspaceTrustHandlerPort {
  return Object.freeze({
    async query(request: WorkspaceTrustQueryRequest): Promise<WorkspaceTrustQueryResponse> {
      const checked = workspaceTrustQueryRequestCodec.decode(
        workspaceTrustQueryRequestCodec.encode(request),
      );
      const response = await input.handler.query(checked);
      return workspaceTrustQueryResponseCodec.decode(workspaceTrustResponseEncode(response));
    },
    async decide(request: WorkspaceTrustDecisionRequest): Promise<WorkspaceTrustDecisionResponse> {
      const checked = workspaceTrustDecisionRequestCodec.decode(
        workspaceTrustDecisionRequestCodec.encode(request),
      );
      const response = await input.handler.decide(checked);
      const projected = workspaceTrustDecisionResponseCodec.decode(
        workspaceTrustDecisionResponseCodec.encode(response),
      );
      assertSameWorkspace(checked.workspace, projected.workspace, 'Workspace Trust response');
      return projected;
    },
  });
}

function workspaceTrustResponseEncode(value: WorkspaceTrustQueryResponse) {
  return workspaceTrustQueryResponseCodec.encode(value);
}
