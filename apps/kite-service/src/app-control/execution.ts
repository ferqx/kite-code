import {
  type ExecutionStatusRequest,
  type ExecutionStatusSnapshot,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  type KiteWorkspaceIdentity,
} from '@kite-ai/kite-app-contract';
import {
  assertAdmittedWorkspace,
  assertSameWorkspace,
  type ExecutionStatusHandlerPort,
} from './ports';

export interface ExecutionStatusHandlerDependencies {
  readonly handler: ExecutionStatusHandlerPort;
  readonly workspace?: KiteWorkspaceIdentity;
}

export function createExecutionStatusHandler(
  input: ExecutionStatusHandlerDependencies,
): ExecutionStatusHandlerPort {
  return Object.freeze({
    async snapshot(request: ExecutionStatusRequest): Promise<ExecutionStatusSnapshot> {
      const checked = executionStatusRequestCodec.decode(
        executionStatusRequestCodec.encode(request),
      );
      assertAdmittedWorkspace(input.workspace, checked.workspace, 'Execution status request');
      const response = await input.handler.snapshot(checked);
      const projected = executionStatusResponseCodec.decode(
        executionStatusResponseCodec.encode(response),
      );
      assertSameWorkspace(checked.workspace, projected.workspace, 'Execution status response');
      return projected;
    },
  });
}
