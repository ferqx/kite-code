import type { RuntimeCommand } from '@kite/runtime-contract';

export type RuntimeCommandOwner = 'host' | 'kernel';

const HOST_COMMANDS: ReadonlySet<RuntimeCommand['type']> = new Set([
  'create_session',
  'resume_session',
  'fork_session',
  'rewind_session',
  'close_session',
]);

/** Classifies the accepted RFC command split without executing domain work. */
export function runtimeCommandOwner(command: RuntimeCommand): RuntimeCommandOwner {
  return HOST_COMMANDS.has(command.type) ? 'host' : 'kernel';
}
