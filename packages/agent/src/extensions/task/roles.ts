export interface TrustedTaskRole {
  readonly id: string;
  readonly version: string;
  readonly modelId?: string;
  readonly toolIds?: readonly string[];
  readonly toolPolicy?: 'parent' | 'read_only';
  readonly description?: string;
}
/** Trusted default Task roles. Role selection never grants effects or permission. */
export const defaultTaskRoles: readonly TrustedTaskRole[] = Object.freeze([
  Object.freeze({
    id: 'worker',
    version: '1',
    toolPolicy: 'parent' as const,
    description:
      'General delegated work using only the parent-selected tools and ordinary permissions.',
  }),
  Object.freeze({
    id: 'code',
    version: '1',
    toolPolicy: 'parent' as const,
    description:
      'Implement a concrete scoped change and verify it; effects still require the original parent and child permissions.',
  }),
  Object.freeze({
    id: 'explore',
    version: '1',
    toolPolicy: 'read_only' as const,
    description:
      'Read-only repository exploration: trace the current entry point and configuration through reachable calls to data, state and output; report evidence and unresolved steps. No modifications or process/network dispatch.',
  }),
  Object.freeze({
    id: 'plan',
    version: '1',
    toolPolicy: 'read_only' as const,
    description:
      'Read-only planning: establish the current entry point, configuration and reachable implementation before proposing scoped changes and verification; report unresolved assumptions. Do not modify files, dispatch effects or approve a plan.',
  }),
  Object.freeze({
    id: 'review',
    version: '1',
    toolPolicy: 'read_only' as const,
    description:
      'Read-only code review: inspect actual changes and reachable surrounding code, identify defects with causal evidence, and state unverified scope. Do not implement changes or dispatch effects.',
  }),
]);

/** Exact existing builtin definitions with read-only behavior; unknown IDs fail closed. */
const readOnlyBindings = [
  ['builtin.files', 'files.read', '4'],
  ['builtin.files.path', 'files.read_path', '2'],
  ['builtin.files', 'files.list', '1'],
  ['builtin.files', 'files.glob', '2'],
  ['builtin.files', 'files.search', '3'],
  ['builtin.shell', 'shell.read', '1'],
  ['builtin.shell', 'shell.wait', '1'],
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
/** Human clarification belongs to the root Agent, even when a child inherits its tools. */
export function isRootOnlyTaskTool(binding: FrozenTaskTool): boolean {
  return (
    binding.extensionId === 'builtin.ask-user' &&
    binding.id === 'ask_user' &&
    binding.version === '1'
  );
}
/** Read-only ceilings use the actual frozen definition, never a matching custom name. */
export function isReadOnlyTaskTool(binding: FrozenTaskTool): boolean {
  return readOnlyBindings.some(
    ([extensionId, id, version]) =>
      binding.extensionId === extensionId && binding.id === id && binding.version === version,
  );
}
