import {
  type BuiltinShellExecutionResultV1,
  classifyBuiltinShellIntentV1,
} from '@kite/builtin-runtime';
import type {
  BuiltinPreparedShellExecutionInputV1,
  BuiltinPreparedShellExecutionResultV1,
  ShellExecutor,
  ShellResult,
} from '@kite/builtin-runtime/sandbox';

/**
 * App-local discovery key for the one Shell execution port selected during
 * startup. It is composition metadata only; it is never persisted or exposed
 * through the Runtime SPI registry.
 */
export const APP_PREPARED_SHELL_EXECUTION_V1 = Symbol.for('kite.app.prepared-shell-execution.v1');

export interface AppPreparedShellExecutionPortV1 {
  readonly execute: (
    input: Readonly<BuiltinPreparedShellExecutionInputV1>,
  ) => Promise<Readonly<BuiltinShellExecutionResultV1>>;
}

export type AppPreparedShellExecutionCarrierV1 = ShellExecutor & {
  readonly [APP_PREPARED_SHELL_EXECUTION_V1]: AppPreparedShellExecutionPortV1;
};

export function appPreparedShellExecutionPortV1(
  executor: ShellExecutor | undefined,
): AppPreparedShellExecutionPortV1 | undefined {
  if (!executor) return undefined;
  const candidate = (executor as Partial<AppPreparedShellExecutionCarrierV1>)[
    APP_PREPARED_SHELL_EXECUTION_V1
  ];
  return candidate && typeof candidate.execute === 'function' ? candidate : undefined;
}

export function projectBuiltinPreparedShellResultV1(
  result: Readonly<BuiltinPreparedShellExecutionResultV1>,
): Readonly<BuiltinShellExecutionResultV1> {
  return Object.freeze({
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    intent: classifyBuiltinShellIntentV1(result.command),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    ...(result.terminationReason === 'timed_out' ? { timedOut: true } : {}),
    ...(result.terminationReason === 'cancelled' ? { aborted: true } : {}),
    ...(result.sandboxFailure ? { sandboxFailure: result.sandboxFailure } : {}),
    ...(result.processCleanup ? { processCleanup: result.processCleanup } : {}),
    executionPhase:
      result.processResult?.executionPhase ??
      (result.sandboxFailure?.stage === 'post_dispatch' ? 'unknown_after_go' : 'not_started'),
  });
}

export function projectAppHostShellResultV1(
  result: Readonly<ShellResult>,
): Readonly<BuiltinShellExecutionResultV1> {
  const executionPhase =
    result.sandboxFailure?.stage === 'pre_dispatch'
      ? ('not_started' as const)
      : result.exitCode === -1 && !result.processCleanup
        ? ('unknown_after_go' as const)
        : ('go_started' as const);
  return Object.freeze({
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    intent: classifyBuiltinShellIntentV1(result.command),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    ...(result.terminationReason === 'timed_out' ? { timedOut: true } : {}),
    ...(result.terminationReason === 'cancelled' ? { aborted: true } : {}),
    ...(result.sandboxFailure ? { sandboxFailure: result.sandboxFailure } : {}),
    ...(result.processCleanup ? { processCleanup: result.processCleanup } : {}),
    executionPhase,
  });
}
