import { AgentError } from '@kite-ai/agent';
import { createTaskExtension, defaultTaskRoleId } from '@kite-ai/agent/task';

import type { ChildRole } from './child-configuration';

export { defaultTaskRoles } from '@kite-ai/agent/task';

const taskIds = new Set([
  'task.spawn',
  'task.message',
  'task.follow_up',
  'task.events',
  'task.list',
  'task.interrupt',
]);
/** Pure host composition; Task roles and their child bindings never originate in JSONC. */
export function createTaskConfiguration(
  declarations: readonly ChildRole[],
  options: { readonly defaultRole?: string; readonly presets?: readonly string[] } = {},
) {
  const roles = declarations.map(({ id, version, description }) => ({ id, version, description }));
  const defaultRole =
    options.defaultRole ??
    (roles.some((role) => role.id === defaultTaskRoleId)
      ? defaultTaskRoleId
      : (roles[0]?.id ?? defaultTaskRoleId));
  const presets = options.presets ?? roles.map((role) => role.id);
  const extension =
    roles.length && roles.length <= 64
      ? createTaskExtension({
          defaultRole,
          presets,
          roles: roles.map(({ id, description }) => ({
            id,
            configurationId: id,
            description:
              description ??
              `Host-registered child ${id}; capabilities remain bounded by the parent.`,
          })),
        })
      : undefined;
  const tools = new Map((extension?.tools ?? []).map((tool) => [tool.id, tool]));
  return {
    extension,
    tools,
    snapshot: {
      available: !!extension,
      roles: roles.map(({ id, version }) => ({
        id,
        configurationId: id,
        configurationVersion: version,
      })),
      tools: [...tools.values()].map(({ id, version }) => ({ id, definitionVersion: version })),
    },
    validateSelection(ids: readonly string[]) {
      if (!extension && ids.some((id) => taskIds.has(id)))
        throw new AgentError('task_role_unavailable');
    },
  };
}
