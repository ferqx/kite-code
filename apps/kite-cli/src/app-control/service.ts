import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  type AppMcpSnapshotRequest,
  type ExecutionStatusRequest,
  type ExecutionStatusSnapshot,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
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
import {
  type AppControlOperationGate,
  assertAdmittedWorkspace,
  assertSameWorkspace,
  type KiteAppControlHandlerPorts,
} from './ports';

export interface KiteAppControlServiceOptions {
  /** Optional connection-scoped Project identity for workspace routes. */
  readonly workspace?: KiteWorkspaceIdentity;
  /** The owner-provided admission gate for every App Control mutation. */
  readonly operationGate: AppControlOperationGate;
  /** Explicit route capabilities; there is no generic method registry. */
  readonly handlers: KiteAppControlHandlerPorts;
}

export type KiteAppControlServiceDependencies = KiteAppControlServiceOptions;

/**
 * Composition-only App Control facade. Each method is a fixed contract route
 * with its own exact request/response codec and handler port. Mutation calls
 * enter the injected OperationGate exactly once and are never retried: a
 * handler may return `outcome_unknown`, which is passed to the caller for an
 * explicit query/decision flow.
 */
export class KiteAppControlService implements KiteAppControlClient {
  readonly #workspace: KiteWorkspaceIdentity | undefined;
  readonly #operationGate: AppControlOperationGate;
  readonly #handlers: KiteAppControlHandlerPorts;

  constructor(input: KiteAppControlServiceOptions) {
    this.#workspace = input.workspace;
    this.#operationGate = input.operationGate;
    this.#handlers = input.handlers;
  }

  async queryWorkspaceTrust(
    request: WorkspaceTrustQueryRequest,
  ): Promise<WorkspaceTrustQueryResponse> {
    const checked = workspaceTrustQueryRequestCodec.decode(
      workspaceTrustQueryRequestCodec.encode(request),
    );
    const response = await this.#handlers.workspaceTrust.query(checked);
    const projected = workspaceTrustQueryResponseCodec.decode(
      workspaceTrustQueryResponseCodec.encode(response),
    );
    if (this.#workspace)
      assertSameWorkspace(this.#workspace, projected.workspace, 'Workspace Trust response');
    return projected;
  }

  async decideWorkspaceTrust(
    request: WorkspaceTrustDecisionRequest,
  ): Promise<WorkspaceTrustDecisionResponse> {
    const checked = workspaceTrustDecisionRequestCodec.decode(
      workspaceTrustDecisionRequestCodec.encode(request),
    );
    if (this.#workspace) {
      assertAdmittedWorkspace(this.#workspace, checked.workspace, 'Workspace Trust request');
    }
    const response = await this.#operationGate.runMutation(() =>
      this.#handlers.workspaceTrust.decide(checked),
    );
    const projected = workspaceTrustDecisionResponseCodec.decode(
      workspaceTrustDecisionResponseCodec.encode(response),
    );
    assertSameWorkspace(checked.workspace, projected.workspace, 'Workspace Trust response');
    return projected;
  }

  async getProviderModelSnapshot(
    request: ProviderModelSnapshotRequest,
  ): Promise<ProviderModelSnapshot> {
    const checked = providerModelSnapshotRequestCodec.decode(
      providerModelSnapshotRequestCodec.encode(request),
    );
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'Provider/model request');
    const response = await this.#handlers.providerModel.snapshot(checked);
    const projected = providerModelSnapshotResponseCodec.decode(
      providerModelSnapshotResponseCodec.encode(response),
    );
    assertSameWorkspace(checked.workspace, projected.workspace, 'Provider/model response');
    return projected;
  }

  async selectProviderModel(
    request: ProviderModelSelectRequest,
  ): Promise<ProviderModelSelectResponse> {
    const checked = providerModelSelectRequestCodec.decode(
      providerModelSelectRequestCodec.encode(request),
    );
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'Provider/model request');
    const response = await this.#operationGate.runMutation(() =>
      this.#handlers.providerModel.select(checked),
    );
    const projected = providerModelSelectResponseCodec.decode(
      providerModelSelectResponseCodec.encode(response),
    );
    assertSameWorkspace(checked.workspace, projected.snapshot.workspace, 'Provider/model response');
    return projected;
  }

  async getMcpSnapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> {
    const checked = mcpSnapshotRequestCodec.decode(mcpSnapshotRequestCodec.encode(request));
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'MCP request');
    const response = await this.#handlers.mcp.snapshot(checked);
    const projected = mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(response));
    assertSameWorkspace(checked.workspace, projected.workspace, 'MCP response');
    return projected;
  }

  async applyMcpAction(request: AppMcpActionRequest): Promise<AppMcpActionResponse> {
    const checked = mcpActionRequestCodec.decode(mcpActionRequestCodec.encode(request));
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'MCP request');
    const response = await this.#operationGate.runMutation(() => this.#handlers.mcp.apply(checked));
    const projected = mcpActionResponseCodec.decode(mcpActionResponseCodec.encode(response));
    assertSameWorkspace(checked.workspace, projected.snapshot.workspace, 'MCP response');
    return projected;
  }

  async getSkillCatalog(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> {
    const checked = skillCatalogRequestCodec.decode(skillCatalogRequestCodec.encode(request));
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'Skill catalog request');
    const response = await this.#handlers.skills.snapshot(checked);
    const projected = skillCatalogResponseCodec.decode(skillCatalogResponseCodec.encode(response));
    assertSameWorkspace(checked.workspace, projected.workspace, 'Skill catalog response');
    return projected;
  }

  async getExecutionStatus(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot> {
    const checked = executionStatusRequestCodec.decode(executionStatusRequestCodec.encode(request));
    assertAdmittedWorkspace(this.#workspace, checked.workspace, 'Execution status request');
    const response = await this.#handlers.execution.snapshot(checked);
    const projected = executionStatusResponseCodec.decode(
      executionStatusResponseCodec.encode(response),
    );
    assertSameWorkspace(checked.workspace, projected.workspace, 'Execution status response');
    return projected;
  }

  async getReleaseStatus(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot> {
    const checked = releaseStatusRequestCodec.decode(releaseStatusRequestCodec.encode(request));
    const response = await this.#handlers.release.snapshot(checked);
    return releaseStatusResponseCodec.decode(releaseStatusResponseCodec.encode(response));
  }
}

export function createKiteAppControlService(
  input: KiteAppControlServiceOptions,
): KiteAppControlService {
  return new KiteAppControlService(input);
}
