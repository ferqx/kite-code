export interface TrustedTaskRole {
  readonly id: string;
  readonly version: string;
  readonly modelId?: string;
  readonly toolIds?: readonly string[];
  readonly toolPolicy?: 'parent' | 'read_only';
  readonly description?: string;
}
export const defaultTaskRoleId = 'general';
/** Trusted default Task roles. Role selection never grants effects or permission. */
export const defaultTaskRoles: readonly TrustedTaskRole[] = Object.freeze([
  Object.freeze({
    id: defaultTaskRoleId,
    version: '1',
    toolPolicy: 'parent' as const,
    description:
      'General delegated work using only the parent-selected tools and ordinary permissions.',
  }),
  Object.freeze({
    id: 'explore',
    version: '1',
    toolPolicy: 'read_only' as const,
    description:
      'Read-only repository exploration: trace the current entry point and configuration through reachable calls to data, state and output; report evidence and unresolved steps. Keep business source, configuration and data unchanged and do not send project data outside the task. Necessary temporary scripts and temporary artifacts may be used for exploration within the inherited permissions. Shell uses the inherited permissions and sandbox; choose commands whose actual effects stay within this assignment.',
  }),
]);

/** Reduced tool surface for read-only assignments; Shell keeps the inherited execution policy. */
const readOnlyBindings = [
  ['builtin.files', 'files.read', '4'],
  ['builtin.files', 'files.read', '5'],
  ['builtin.files', 'files.view_images', '1'],
  ['builtin.shell', 'shell.execute', '1'],
  ['builtin.shell', 'shell.launch', '1'],
  ['builtin.shell', 'shell.read', '1'],
  ['builtin.shell', 'shell.wait', '1'],
  ['builtin.shell', 'shell.stop', '1'],
  ['builtin.task', 'task.message', '1'],
  ['builtin.task', 'task.events', '1'],
  ['builtin.execution-evidence', 'execution_evidence.read', '1'],
  ['builtin.web', 'web_fetch', '1'],
  ['builtin.planning', 'planning.read', '1'],
  ['builtin.skills', 'skills.load', '1'],
  ['builtin.skills', 'skills.resource', '1'],
] as const;
export const readOnlyTaskToolIds = Object.freeze(readOnlyBindings.map((binding) => binding[1]));
interface FrozenTaskTool {
  readonly extensionId?: unknown;
  readonly id?: unknown;
  readonly version?: unknown;
}
/** Exact builtin creation identity; matching model names do not establish ownership. */
export function isAgentCreationTaskTool(binding: FrozenTaskTool): boolean {
  return (
    binding.extensionId === 'builtin.task' && binding.id === 'task.spawn' && binding.version === '1'
  );
}
/** Only root Agents observe the builtin Task event mailbox; frozen bindings remain valid. */
export function isRootAgentObservationTaskTool(binding: FrozenTaskTool): boolean {
  return (
    binding.extensionId === 'builtin.task' &&
    binding.id === 'task.events' &&
    binding.version === '1'
  );
}
/** Human clarification belongs to the root Agent, even when a child inherits its tools. */
export function isRootOnlyTaskTool(binding: FrozenTaskTool): boolean {
  return (
    binding.extensionId === 'builtin.ask-user' &&
    binding.id === 'ask_user' &&
    binding.version === '1'
  );
}
/** Tool filtering uses the actual frozen definition, never a matching custom name. */
export function isReadOnlyTaskTool(binding: FrozenTaskTool): boolean {
  return readOnlyBindings.some(
    ([extensionId, id, version]) =>
      binding.extensionId === extensionId && binding.id === id && binding.version === version,
  );
}
