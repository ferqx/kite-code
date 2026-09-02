import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  type AppMcpSnapshotRequest,
  type ExactJsonCodec,
  type ExecutionStatusRequest,
  type ExecutionStatusSnapshot,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  type KiteAppControlClient,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSnapshot,
  type ProviderModelSnapshotRequest,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  type ReleaseStatusRequest,
  type ReleaseStatusSnapshot,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  type SkillCatalogRequest,
  type SkillCatalogSnapshot,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';
import type { RuntimeClient } from '@kite-ai/runtime-client';
import type { RuntimeProtocolAppControlMethod } from '@kite-ai/runtime-protocol';

type AppControlRequester = Pick<RuntimeClient, 'requestAppControl'>;

/** Exact App Control adapter for a RuntimeClient sharing the App Server logical connection. */
export class ProtocolKiteAppControlClient implements KiteAppControlClient {
  readonly #runtime: AppControlRequester;

  constructor(runtime: AppControlRequester) {
    this.#runtime = runtime;
  }

  queryWorkspaceTrust(request: WorkspaceTrustQueryRequest): Promise<WorkspaceTrustQueryResponse> {
    return this.#call(
      'app/workspace_trust/query',
      workspaceTrustQueryRequestCodec,
      workspaceTrustQueryResponseCodec,
      request,
    );
  }

  decideWorkspaceTrust(
    request: WorkspaceTrustDecisionRequest,
  ): Promise<WorkspaceTrustDecisionResponse> {
    return this.#call(
      'app/workspace_trust/decide',
      workspaceTrustDecisionRequestCodec,
      workspaceTrustDecisionResponseCodec,
      request,
    );
  }

  getProviderModelSnapshot(request: ProviderModelSnapshotRequest): Promise<ProviderModelSnapshot> {
    return this.#call(
      'app/provider_model/snapshot',
      providerModelSnapshotRequestCodec,
      providerModelSnapshotResponseCodec,
      request,
    );
  }

  selectProviderModel(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse> {
    return this.#call(
      'app/provider_model/select',
      providerModelSelectRequestCodec,
      providerModelSelectResponseCodec,
      request,
    );
  }

  getMcpSnapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> {
    return this.#call(
      'app/mcp/snapshot',
      mcpSnapshotRequestCodec,
      mcpSnapshotResponseCodec,
      request,
    );
  }

  applyMcpAction(request: AppMcpActionRequest): Promise<AppMcpActionResponse> {
    return this.#call('app/mcp/action', mcpActionRequestCodec, mcpActionResponseCodec, request);
  }

  getSkillCatalog(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> {
    return this.#call(
      'app/skills/catalog',
      skillCatalogRequestCodec,
      skillCatalogResponseCodec,
      request,
    );
  }

  getExecutionStatus(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot> {
    return this.#call(
      'app/execution/status',
      executionStatusRequestCodec,
      executionStatusResponseCodec,
      request,
    );
  }

  getReleaseStatus(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot> {
    return this.#call(
      'app/release/status',
      releaseStatusRequestCodec,
      releaseStatusResponseCodec,
      request,
    );
  }

  async #call<Request, Response>(
    method: RuntimeProtocolAppControlMethod,
    requestCodec: ExactJsonCodec<Request>,
    responseCodec: ExactJsonCodec<Response>,
    request: Request,
  ): Promise<Response> {
    const response = await this.#runtime.requestAppControl(method, requestCodec.encode(request));
    return responseCodec.decode(response);
  }
}

export function createProtocolKiteAppControlClient(
  runtime: AppControlRequester,
): KiteAppControlClient {
  return new ProtocolKiteAppControlClient(runtime);
}
