import {
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  type KiteAppControlClient,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';

/**
 * InProcess conformance adapter for the exact App Control seam. Both request and response pass
 * through the same codecs used by the later local transport, so tests cannot hide Manager or
 * callback passthrough behind same-process object identity.
 */
export function createInProcessKiteAppControlClient(
  service: KiteAppControlClient,
): KiteAppControlClient {
  const client: KiteAppControlClient = {
    async queryWorkspaceTrust(request) {
      const input = workspaceTrustQueryRequestCodec.decode(
        workspaceTrustQueryRequestCodec.encode(request),
      );
      const response = await service.queryWorkspaceTrust(input);
      return workspaceTrustQueryResponseCodec.decode(
        workspaceTrustQueryResponseCodec.encode(response),
      );
    },
    async decideWorkspaceTrust(request) {
      const input = workspaceTrustDecisionRequestCodec.decode(
        workspaceTrustDecisionRequestCodec.encode(request),
      );
      const response = await service.decideWorkspaceTrust(input);
      return workspaceTrustDecisionResponseCodec.decode(
        workspaceTrustDecisionResponseCodec.encode(response),
      );
    },
    async getProviderModelSnapshot(request) {
      const input = providerModelSnapshotRequestCodec.decode(
        providerModelSnapshotRequestCodec.encode(request),
      );
      const response = await service.getProviderModelSnapshot(input);
      return providerModelSnapshotResponseCodec.decode(
        providerModelSnapshotResponseCodec.encode(response),
      );
    },
    async selectProviderModel(request) {
      const input = providerModelSelectRequestCodec.decode(
        providerModelSelectRequestCodec.encode(request),
      );
      const response = await service.selectProviderModel(input);
      return providerModelSelectResponseCodec.decode(
        providerModelSelectResponseCodec.encode(response),
      );
    },
    async getMcpSnapshot(request) {
      const input = mcpSnapshotRequestCodec.decode(mcpSnapshotRequestCodec.encode(request));
      const response = await service.getMcpSnapshot(input);
      return mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(response));
    },
    async applyMcpAction(request) {
      const input = mcpActionRequestCodec.decode(mcpActionRequestCodec.encode(request));
      const response = await service.applyMcpAction(input);
      return mcpActionResponseCodec.decode(mcpActionResponseCodec.encode(response));
    },
    async getSkillCatalog(request) {
      const input = skillCatalogRequestCodec.decode(skillCatalogRequestCodec.encode(request));
      const response = await service.getSkillCatalog(input);
      return skillCatalogResponseCodec.decode(skillCatalogResponseCodec.encode(response));
    },
    async getExecutionStatus(request) {
      const input = executionStatusRequestCodec.decode(executionStatusRequestCodec.encode(request));
      const response = await service.getExecutionStatus(input);
      return executionStatusResponseCodec.decode(executionStatusResponseCodec.encode(response));
    },
    async getReleaseStatus(request) {
      const input = releaseStatusRequestCodec.decode(releaseStatusRequestCodec.encode(request));
      const response = await service.getReleaseStatus(input);
      return releaseStatusResponseCodec.decode(releaseStatusResponseCodec.encode(response));
    },
  };
  return Object.freeze(client);
}
