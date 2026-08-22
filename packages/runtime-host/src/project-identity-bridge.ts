import type {
  RuntimeCommandReceipt,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite/runtime-contract';
import type { RuntimeHostExecutionBridge, RuntimeHostPreparedExecution } from './execution-bridge';
import type { RuntimeHostKernelInput } from './kernel-input';
import { runtimeCommandFromKernelInput } from './kernel-input';
import type { ProjectIdentityStoreV1 } from './project-identity';

/**
 * Host-owned CreateSession identity gate. The App may issue a Handle, but only
 * this Host wrapper verifies it before the concrete bridge can create state.
 */
export function bindProjectIdentityToRuntimeBridgeV1(input: {
  readonly projects: ProjectIdentityStoreV1;
  readonly bridge: RuntimeHostExecutionBridge;
}): RuntimeHostExecutionBridge {
  return Object.freeze({
    recoverSession: (sessionId: string, publish: (notification: RuntimeNotification) => void) =>
      input.bridge.recoverSession(sessionId, publish),
    prepare: async (
      kernelInput: RuntimeHostKernelInput,
      publish: (notification: RuntimeNotification) => void,
    ): Promise<RuntimeHostPreparedExecution> => {
      const command = runtimeCommandFromKernelInput(kernelInput);
      if (command.type === 'create_session') {
        try {
          const project = input.projects.verifyHandleSync({
            handle: command.projectHandle,
            workspace: command.workspace,
          });
          const expectedBootstrapIdentity = command.bootstrapSessionId ?? command.commandId;
          if (
            command.projectHandle.bootstrapIdentity !== expectedBootstrapIdentity ||
            command.projectHandle.project.projectId !== project.projectId
          ) {
            throw new Error('ProjectHandle bootstrap identity mismatch.');
          }
        } catch {
          const receipt: RuntimeCommandReceipt = {
            status: 'rejected',
            commandId: command.commandId,
            code: 'invalid_session',
          };
          return { receipt };
        }
      }
      return input.bridge.prepare(kernelInput, publish);
    },
    query: (query: RuntimeQuery): Promise<RuntimeQueryResult> => input.bridge.query(query),
    shutdownSession: (
      sessionId: string,
      reason: string,
      publish: (notification: RuntimeNotification) => void,
    ) => input.bridge.shutdownSession(sessionId, reason, publish),
    close: () => input.bridge.close(),
  });
}
