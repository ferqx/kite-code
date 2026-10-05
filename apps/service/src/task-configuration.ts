import { AgentError } from '@kite-ai/agent';
import { createTaskExtension } from '@kite-ai/agent/task';
import type { ChildRole } from './child-configuration';
import type { CapabilityEffect } from './permissions';

const taskIds = new Set([
  'task',
  'task_read',
  'task_wait',
  'task_cancel',
  'send_message',
  'followup_task',
  'list_agents',
  'interrupt_agent',
  'wait_agents',
  'wait_agent',
]);
/** Pure host composition; Task roles and their child bindings never originate in JSONC. */
export function createTaskConfiguration(
  declarations: readonly ChildRole[],
  options: { readonly afterTurn?: { enabled: true } } = {},
) {
  const roles = declarations.map(({ id, version }) => ({ id, version }));
  const extension =
    roles.length && roles.length <= 64
      ? createTaskExtension({
          roles: roles.map(({ id }) => ({
            id,
            configurationId: id,
            description: `Host-registered child ${id}; capabilities remain bounded by the parent.`,
          })),
          ...(options.afterTurn ? { afterTurn: { enabled: true } } : {}),
        })
      : undefined;
  const tools = new Map((extension?.tools ?? []).map((tool) => [tool.id, tool]));
  return {
    extension,
    tools,
    snapshot: {
      available: !!extension,
      afterTurn: !!extension && options.afterTurn?.enabled === true,
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
    describe(id: string): { effects: readonly CapabilityEffect[]; safeRead: boolean } {
      if (['task_read', 'task_wait', 'list_agents', 'wait_agents', 'wait_agent'].includes(id))
        return { effects: ['read'], safeRead: true };
      if (id === 'task' || id === 'send_message' || id === 'followup_task')
        return { effects: ['unknown', 'record_write'], safeRead: false };
      return { effects: ['unknown'], safeRead: false };
    },
  };
}
