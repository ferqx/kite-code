import type { KernelInput } from '@kite/agent-kernel';
import type { RuntimeCommand } from '@kite/runtime-contract';
import { type RuntimeCommandOwner, runtimeCommandOwner } from '../host/command-router';

export interface RuntimeCommandKernelEvent {
  readonly type: 'runtime.command_observed';
  readonly owner: RuntimeCommandOwner;
  readonly command: RuntimeCommand;
}

export type RuntimeHostKernelInput = KernelInput<RuntimeCommandKernelEvent>;

/** Host-owned translation; Contract DTO identity never becomes Kernel authority. */
export function translateRuntimeCommandToKernelInput(
  command: RuntimeCommand,
): RuntimeHostKernelInput {
  return Object.freeze({
    source: 'command',
    sessionId: runtimeCommandSessionId(command),
    expectedRevision: 'expectedRevision' in command ? command.expectedRevision : 0,
    events: Object.freeze([
      Object.freeze({
        type: 'runtime.command_observed' as const,
        owner: runtimeCommandOwner(command),
        command,
      }),
    ]),
    causationId: command.commandId,
  });
}

export function runtimeCommandSessionId(command: RuntimeCommand): string {
  if (command.type === 'create_session') {
    return command.bootstrapSessionId ?? `create:${command.commandId}`;
  }
  if (command.type === 'fork_session') return command.sourceSessionId;
  return command.sessionId;
}

export function runtimeCommandFromKernelInput(input: RuntimeHostKernelInput): RuntimeCommand {
  const observed = input.events[0];
  if (
    input.source !== 'command' ||
    input.events.length !== 1 ||
    !observed ||
    observed.type !== 'runtime.command_observed' ||
    input.causationId !== observed.command.commandId ||
    observed.owner !== runtimeCommandOwner(observed.command) ||
    input.sessionId !== runtimeCommandSessionId(observed.command)
  ) {
    throw new Error('Runtime Host KernelInput is invalid.');
  }
  return observed.command;
}
