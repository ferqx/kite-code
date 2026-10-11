import type { AuthorizationRequest } from '../extensions';
import type { WorkflowCapability } from '../skills/workflow-contract';
import type { CapabilityDescription, CapabilityEffect } from './index';

const planningRecordWrites = new Set([
  'planning.write',
  'planning.update',
  'planning.review',
  'validation.define',
  'validation.check',
  'validation.auto_check',
  'validation.rebind',
  'validation.request_waiver',
  'validation.waive',
]);
export function planningEffect(id: string): CapabilityEffect {
  return id === 'planning.read'
    ? 'read'
    : planningRecordWrites.has(id)
      ? 'record_write'
      : 'unknown';
}
export function hostReadOnlyTool(extensionId: string, toolId: string) {
  return (
    (extensionId === 'builtin.files' &&
      ['files.read', 'files.list', 'files.glob', 'files.search'].includes(toolId)) ||
    (extensionId === 'builtin.skills' && ['skills.load', 'skills.resource'].includes(toolId)) ||
    (extensionId === 'builtin.mcp.sources' && toolId === 'mcp.sources.list') ||
    (extensionId === 'builtin.planning' && toolId === 'planning.read') ||
    (extensionId === 'builtin.ask-user' && toolId === 'ask_user')
  );
}
/** Trusted builtin file effect classification; unknown extensions keep unknown effects. */
export function builtinToolEffect(
  extensionId: string,
  toolId: string,
  planningId: string,
): CapabilityEffect {
  const read = hostReadOnlyTool(extensionId, toolId);
  const write =
    extensionId === 'builtin.files' &&
    ['files.write', 'files.edit', 'files.mkdir'].includes(toolId);
  return extensionId === planningId
    ? planningEffect(toolId)
    : read
      ? 'read'
      : write
        ? 'workspace_write'
        : 'unknown';
}

/** Task capability effects are stable rules; host composition supplies actual registered tools. */
export function taskToolCapability(id: string): {
  effects: readonly CapabilityEffect[];
  safeRead: boolean;
} {
  if (['task_read', 'task_wait', 'list_agents', 'wait_agents', 'wait_agent'].includes(id))
    return { effects: ['read'], safeRead: true };
  if (id === 'task' || id === 'send_message' || id === 'followup_task')
    return { effects: ['unknown', 'record_write'], safeRead: false };
  return { effects: ['unknown'], safeRead: false };
}

export function shellToolCapability(id: string): {
  effects: readonly CapabilityEffect[];
  safeRead: boolean;
} {
  if (id === 'shell.read' || id === 'shell.wait') return { effects: ['read'], safeRead: true };
  if (id === 'shell.launch')
    return { effects: ['process', 'unknown', 'record_write'], safeRead: false };
  return { effects: ['process', 'unknown'], safeRead: false };
}

/** Classify the actual registered Tool, Job or Action; an Action dispatches as a Job. */
export function builtinCapability(
  extensionId: string,
  definitionId: string,
  kind: 'tool' | 'job' | 'action',
  planningId: string,
): { effects: readonly CapabilityEffect[]; safeRead: boolean } {
  if (kind === 'action' && extensionId === planningId)
    return { effects: [planningEffect(definitionId)], safeRead: false };
  if (kind === 'action' && extensionId === 'builtin.files')
    return { effects: ['workspace_write'], safeRead: false };
  if (kind !== 'tool')
    return {
      effects: extensionId === 'builtin.shell' ? ['process', 'unknown'] : ['unknown'],
      safeRead: false,
    };
  const toolId = definitionId;
  if (extensionId === 'builtin.task') return taskToolCapability(toolId);
  if (extensionId === 'builtin.shell') return shellToolCapability(toolId);
  return {
    effects:
      extensionId === 'builtin.ask-user'
        ? []
        : [builtinToolEffect(extensionId, toolId, planningId)],
    safeRead: hostReadOnlyTool(extensionId, toolId),
  };
}

/** Workflow keeps its original conservative Job and unknown-file ceilings. */
export function workflowCapabilityDescription(
  description: Pick<
    CapabilityDescription,
    'definitionId' | 'definitionVersion' | 'revision' | 'effects'
  > & { kind: 'tool' | 'job'; extensionId?: string },
): {
  kind: 'tool' | 'job';
  definitionId: string;
  definitionVersion: string;
  capability: WorkflowCapability;
} {
  const { kind, definitionId, definitionVersion, revision } = description;
  // Permission classification treats an unknown Files tool as unknown; the existing
  // Workflow contract conservatively reserves workspace writes for that projection.
  const effects: readonly CapabilityEffect[] =
    kind === 'tool' &&
    description.extensionId === 'builtin.files' &&
    description.effects.includes('unknown')
      ? (['workspace_write'] as const)
      : description.effects;
  return {
    kind,
    definitionId,
    definitionVersion,
    capability: {
      capabilityId: definitionId,
      revision,
      availability: 'available',
      effectiveEffects: {
        filesystem:
          kind === 'job'
            ? 'unknown'
            : effects.length === 0
              ? 'none'
              : effects.includes('workspace_write')
                ? 'write'
                : effects.every((effect) => effect === 'read')
                  ? 'read'
                  : 'unknown',
        network: kind === 'job' || effects.includes('network') ? 'unknown' : 'none',
        externalState:
          kind === 'job' ||
          effects.some((effect) => ['external', 'process', 'unknown'].includes(effect))
            ? 'unknown'
            : 'none',
      },
      policy: {
        minimumApproval:
          kind === 'tool' && effects.every((effect) => effect === 'read') ? 'none' : 'user',
      },
    },
  };
}

/** Fixed source capability rules; the host supplies trusted registered definition IDs. */
export function createMcpSourceCapabilityDescription(options: {
  readonly extensionId: string;
  readonly directoryToolId: string;
  readonly connectionJobId: string;
}): (request: AuthorizationRequest) => CapabilityDescription | null {
  return (request: AuthorizationRequest): CapabilityDescription | null => {
    if (
      request.kind === 'job' &&
      ['login', 'refresh', 'clear', 'revoke'].some(
        (action) => request.definitionId === `${options.extensionId}/mcp.auth.${action}`,
      ) &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: request.definitionId.endsWith('/mcp.auth.clear')
          ? ['external']
          : ['network', 'external'],
        hardAllowed: true,
        safeRead: false,
      };
    if (
      request.kind === 'tool' &&
      request.definitionId === options.directoryToolId &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'tool',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: ['read'],
        hardAllowed: true,
        safeRead: true,
      };
    if (
      request.kind === 'job' &&
      request.definitionId === options.connectionJobId &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: ['unknown'],
        hardAllowed: true,
        safeRead: false,
      };
    if (
      request.kind === 'job' &&
      [
        `${options.extensionId}/mcp.source.approve`,
        `${options.extensionId}/mcp.credential.bind`,
        `${options.extensionId}/mcp.source.add`,
        `${options.extensionId}/mcp.source.remove`,
      ].includes(request.definitionId) &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: request.definitionId.endsWith('/mcp.source.remove')
          ? ['workspace_write', 'external']
          : ['workspace_write'],
        hardAllowed: true,
        safeRead: false,
      };
    return null;
  };
}
