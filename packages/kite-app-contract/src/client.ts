import type {
  AppMcpActionRequest,
  AppMcpActionResponse,
  AppMcpSnapshot,
  AppMcpSnapshotRequest,
} from './mcp';
import type {
  ProviderModelSelectRequest,
  ProviderModelSelectResponse,
  ProviderModelSnapshot,
  ProviderModelSnapshotRequest,
} from './provider-model';
import type { SkillCatalogRequest, SkillCatalogSnapshot } from './skills';
import type {
  ExecutionStatusRequest,
  ExecutionStatusSnapshot,
  ReleaseStatusRequest,
  ReleaseStatusSnapshot,
} from './status';
import type {
  WorkspaceTrustDecisionRequest,
  WorkspaceTrustDecisionResponse,
  WorkspaceTrustQueryRequest,
  WorkspaceTrustQueryResponse,
} from './workspace-trust';

/**
 * Closed App Control surface for the current terminal journeys.  Each method
 * maps to one registered route and has a dedicated request/response codec;
 * there is intentionally no stringly-typed call or object passthrough.
 */
export interface KiteAppControlClient {
  queryWorkspaceTrust(request: WorkspaceTrustQueryRequest): Promise<WorkspaceTrustQueryResponse>;
  decideWorkspaceTrust(
    request: WorkspaceTrustDecisionRequest,
  ): Promise<WorkspaceTrustDecisionResponse>;
  getProviderModelSnapshot(request: ProviderModelSnapshotRequest): Promise<ProviderModelSnapshot>;
  selectProviderModel(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse>;
  getMcpSnapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot>;
  applyMcpAction(request: AppMcpActionRequest): Promise<AppMcpActionResponse>;
  getSkillCatalog(request: SkillCatalogRequest): Promise<SkillCatalogSnapshot>;
  getExecutionStatus(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot>;
  getReleaseStatus(request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot>;
}
