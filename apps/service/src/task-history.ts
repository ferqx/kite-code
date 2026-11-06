import { isDeepStrictEqual } from 'node:util';
import { AgentError } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import type { ChildRole } from './child-configuration';

// Exact declarations produced by 8e350f99ed6651d2c5db82fca3430d5d0d27b01e.
// These bind persisted work only; they are never the current model's preset catalogue.
export const previousTaskRoles: readonly ChildRole[] = Object.freeze(
  [
    {
      id: 'worker',
      version: '1',
      toolPolicy: 'parent',
      description:
        'General delegated work using only the parent-selected tools and ordinary permissions.',
    },
    {
      id: 'code',
      version: '1',
      toolPolicy: 'parent',
      description:
        'Implement a concrete scoped change and verify it; effects still require the original parent and child permissions.',
    },
    {
      id: 'explore',
      version: '1',
      toolPolicy: 'read_only',
      description:
        'Read-only repository exploration: trace the current entry point and configuration through reachable calls to data, state and output; report evidence and unresolved steps. Keep business source, configuration and data unchanged and do not send project data outside the task. Necessary temporary scripts and temporary artifacts may be used for exploration within the inherited permissions. Shell uses the inherited permissions and sandbox; choose commands whose actual effects stay within this assignment.',
    },
    {
      id: 'plan',
      version: '1',
      toolPolicy: 'read_only',
      description:
        'Read-only planning: establish the current entry point, configuration and reachable implementation before proposing scoped changes and verification; report unresolved assumptions. Keep business source, configuration and data unchanged; do not send project data outside the task or approve a plan. Necessary temporary scripts and temporary artifacts may be used for exploration within the inherited permissions. Shell uses the inherited permissions and sandbox; keep its actual effects within this assignment.',
    },
    {
      id: 'review',
      version: '1',
      toolPolicy: 'read_only',
      description:
        'Read-only code review: inspect actual changes and reachable surrounding code, identify defects with causal evidence, and state unverified scope. Keep business source, configuration and data unchanged; do not implement changes or send project data outside the task. Necessary temporary scripts and temporary artifacts may be used for exploration within the inherited permissions. Shell uses the inherited permissions and sandbox; choose commands whose actual effects stay within this assignment.',
    },
  ].map((role) => Object.freeze(role as ChildRole)),
);

export interface TaskCatalogue {
  readonly roles: readonly ChildRole[];
  readonly previous: boolean;
}
export const previousReadOnlyTaskToolIds = Object.freeze([
  'files.read',
  'files.view_images',
  'shell.execute',
  'shell.launch',
  'shell.read',
  'shell.wait',
  'planning.read',
  'skills.load',
  'skills.resource',
]);
const object = (value: Json | undefined): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const roleIdentity = (roles: readonly ChildRole[]) =>
  roles.map(({ id, version }) => ({
    id,
    configurationId: id,
    configurationVersion: version,
  }));

/** Only a Runtime-verified original Run supplies this snapshot. No caller-selected role aliases. */
export function readTaskCatalogue(
  snapshot: Json | undefined,
  current: readonly ChildRole[],
  allowPrevious: boolean,
): TaskCatalogue {
  let roles = current;
  let previous = false;
  if (snapshot !== undefined) {
    if (
      !object(snapshot) ||
      !Array.isArray(snapshot.roles) ||
      !Array.isArray(snapshot.tools) ||
      Object.keys(snapshot).sort().join(',') !== 'available,roles,tools'
    )
      throw new AgentError('recovery_configuration_unavailable');
    if (!isDeepStrictEqual(snapshot.roles, roleIdentity(current))) {
      if (!allowPrevious || !isDeepStrictEqual(snapshot.roles, roleIdentity(previousTaskRoles)))
        throw new AgentError('recovery_configuration_unavailable');
      roles = previousTaskRoles;
      previous = true;
    }
    if (snapshot.available !== roles.length > 0)
      throw new AgentError('recovery_configuration_unavailable');
    const known = [
      'task.spawn',
      'task.follow_up',
      'task.interrupt',
      'task.message',
      'task.events',
      'task.list',
    ];
    const seen = new Set<string>();
    for (const tool of snapshot.tools) {
      if (
        !object(tool) ||
        Object.keys(tool).sort().join(',') !== 'definitionVersion,id' ||
        typeof tool.id !== 'string' ||
        !known.includes(tool.id) ||
        tool.definitionVersion !== '1' ||
        seen.has(tool.id)
      )
        throw new AgentError('recovery_configuration_unavailable');
      seen.add(tool.id);
    }
  }
  return { roles, previous };
}

export function taskSnapshotFromRun(configuration: Json | undefined): Json | undefined {
  if (!object(configuration) || !object(configuration.snapshot)) return undefined;
  const snapshot = configuration.snapshot;
  const service =
    typeof snapshot.roleId === 'string' && object(snapshot.configuration)
      ? snapshot.configuration
      : snapshot;
  return service.task;
}
