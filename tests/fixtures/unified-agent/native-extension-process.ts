import type { AgentRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import type { ConfigureProcessHost } from '@kite-ai/service/bootstrap';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runServiceProcess as runDefaultServiceProcess } from '@kite-ai/service/main';
import { runtimeProtectionRoots } from '@kite-ai/service/runtime-protection';
import type { PermissionManagementPort } from '../../../apps/service/src/permission-management';
import { createPermissionPolicy } from '../../../apps/service/src/permissions';
import { createMiniReview } from '../extensions/mini-review/src';

/** Explicit immutable test composition with trusted classification for the reference definitions. */
const configure: ConfigureProcessHost = async (startup, context) => {
  const defaults = await createDefaultProcessConfiguration({
    profile: selectProfile(startup.profile),
    observerSubjectId: context.subjectId,
    hostConfiguration: startup.hostConfiguration,
    runtimeAssets: [
      process.argv[1]!,
      ...(startup.runtimeProtection ? runtimeProtectionRoots(startup.runtimeProtection) : []),
    ],
  });
  const reference = createMiniReview().extension;
  let runtime: AgentRuntime | undefined, managed: PermissionManagementPort | undefined;
  const descriptions = [
    ...(reference.actions ?? []).map((action) => ({
      kind: 'job' as const,
      definitionId: `${reference.id}/${action.id}`,
      definitionVersion: action.version,
      revision: 'reference-1',
      effects: ['record_write' as const],
      hardAllowed: true,
      safeRead: false,
    })),
    ...(reference.tools ?? []).map((tool) => ({
      kind: 'tool' as const,
      definitionId: tool.id,
      definitionVersion: tool.version,
      revision: 'reference-1',
      effects: ['read' as const],
      hardAllowed: true,
      safeRead: true,
    })),
  ];
  const describe = (request: { kind: string; definitionId: string; definitionVersion: string }) =>
    descriptions.find(
      (value) =>
        value.kind === request.kind &&
        value.definitionId === request.definitionId &&
        value.definitionVersion === request.definitionVersion,
    ) ?? null;
  const policy = createPermissionPolicy({
    describeCapability: describe,
    async readPolicy(request) {
      if (!runtime || !managed) throw Error('reference_permission_host_unbound');
      const execution = await runtime.getExecution(request.executionId),
        command = execution && (await runtime.getCommand(execution.originCommandId)),
        session = execution && (await runtime.getSession(execution.sessionId));
      if (
        !execution ||
        !command ||
        !session ||
        execution.sessionId !== request.sessionId ||
        command.originStoreId !== execution.originStoreId
      )
        throw Error('reference_permission_scope_invalid');
      const identity = { expectedStoreId: execution.originStoreId, subjectId: command.subjectId },
        mode = await managed.readMode({ ...identity, sessionId: session.id }),
        trust = await managed.readTrust({ ...identity, workspaceId: session.workspaceId });
      return {
        mode: mode.mode,
        workspaceTrust: trust.trusted,
        revision: `reference:${mode.revision}:${mode.defaultRevision}:${trust.revision}`,
        allowed: descriptions,
        controlReads: [
          {
            kind: 'permission.mode',
            scope: `session:${mode.scopeSessionId}`,
            revision: mode.revision,
          },
          { kind: 'permission.mode', scope: 'user', revision: mode.defaultRevision },
          {
            kind: 'workspace.trust',
            scope: `workspace:${session.workspaceId}`,
            revision: trust.revision,
          },
        ],
      };
    },
  });
  return {
    ...defaults,
    extensions: [...(defaults.extensions ?? []), reference],
    permissionManagement(value) {
      runtime = value;
      managed = defaults.permissionManagement!(value);
      return managed;
    },
    permissions: {
      authorize: (request) =>
        describe(request) ? policy.authorize(request) : defaults.permissions!.authorize(request),
    },
  };
};

export function runServiceProcess(): Promise<void> {
  return runDefaultServiceProcess({ configure });
}
