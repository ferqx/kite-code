import {
  type KiteWorkspaceIdentity,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSetEnabledRequest,
  type ProviderModelSetEnabledResponse,
  type ProviderModelSnapshot,
  type ProviderModelSnapshotRequest,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSetEnabledRequestCodec,
  providerModelSetEnabledResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
} from '@kite-ai/kite-app-contract';
import {
  assertAdmittedWorkspace,
  assertSameWorkspace,
  type ProviderModelHandlerPort,
} from './ports';

export interface ProviderModelHandlerDependencies {
  readonly handler: ProviderModelHandlerPort;
  readonly workspace?: KiteWorkspaceIdentity;
}

export function createProviderModelHandler(
  input: ProviderModelHandlerDependencies,
): ProviderModelHandlerPort {
  return Object.freeze({
    async snapshot(request: ProviderModelSnapshotRequest): Promise<ProviderModelSnapshot> {
      const checked = providerModelSnapshotRequestCodec.decode(
        providerModelSnapshotRequestCodec.encode(request),
      );
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'Provider/model request');
      const response = await input.handler.snapshot(checked);
      const projected = providerModelSnapshotResponseCodec.decode(
        providerModelSnapshotResponseCodec.encode(response),
      );
      assertSameWorkspace(checked.workspace, projected.workspace, 'Provider/model response');
      return projected;
    },
    async select(request: ProviderModelSelectRequest): Promise<ProviderModelSelectResponse> {
      const checked = providerModelSelectRequestCodec.decode(
        providerModelSelectRequestCodec.encode(request),
      );
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'Provider/model request');
      const response = await input.handler.select(checked);
      const projected = providerModelSelectResponseCodec.decode(
        providerModelSelectResponseCodec.encode(response),
      );
      assertSameWorkspace(
        checked.workspace,
        projected.snapshot.workspace,
        'Provider/model response',
      );
      return projected;
    },
    async setEnabled(
      request: ProviderModelSetEnabledRequest,
    ): Promise<ProviderModelSetEnabledResponse> {
      const checked = providerModelSetEnabledRequestCodec.decode(
        providerModelSetEnabledRequestCodec.encode(request),
      );
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'Provider/model request');
      const response = await input.handler.setEnabled(checked);
      const projected = providerModelSetEnabledResponseCodec.decode(
        providerModelSetEnabledResponseCodec.encode(response),
      );
      assertSameWorkspace(
        checked.workspace,
        projected.snapshot.workspace,
        'Provider/model response',
      );
      return projected;
    },
  });
}
