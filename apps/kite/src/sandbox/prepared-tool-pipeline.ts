import {
  type BuiltinShellExecutionResult,
  classifyBuiltinShellIntent,
} from '@kite/builtin-runtime';
import type {
  BuiltinPreparedShellExecutionInput,
  BuiltinPreparedShellExecutionResult,
  ShellExecutor,
  ShellResult,
} from '@kite/builtin-runtime/sandbox';

/**
 * App-local discovery key for the one Shell execution port selected during
 * startup. It is composition metadata only; it is never persisted or exposed
 * through the Runtime SPI registry.
 */
export const APP_PREPARED_SHELL_EXECUTION_ = Symbol.for('kite.app.prepared-shell-execution.v1');

export interface AppPreparedShellExecutionPort {
  readonly execute: (
    input: Readonly<BuiltinPreparedShellExecutionInput>,
  ) => Promise<Readonly<BuiltinShellExecutionResult>>;
}

export type AppPreparedShellExecutionCarrier = ShellExecutor & {
  readonly [APP_PREPARED_SHELL_EXECUTION_]: AppPreparedShellExecutionPort;
};

export function appPreparedShellExecutionPort(
  executor: ShellExecutor | undefined,
): AppPreparedShellExecutionPort | undefined {
  if (!executor) return undefined;
  const candidate = (executor as Partial<AppPreparedShellExecutionCarrier>)[
    APP_PREPARED_SHELL_EXECUTION_
  ];
  return candidate && typeof candidate.execute === 'function' ? candidate : undefined;
}

export function projectBuiltinPreparedShellResult(
  result: Readonly<BuiltinPreparedShellExecutionResult>,
): Readonly<BuiltinShellExecutionResult> {
  return Object.freeze({
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    intent: classifyBuiltinShellIntent(result.command),
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

export function projectAppHostShellResult(
  result: Readonly<ShellResult>,
): Readonly<BuiltinShellExecutionResult> {
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
    intent: classifyBuiltinShellIntent(result.command),
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
    ...(result.terminationReason === 'timed_out' ? { timedOut: true } : {}),
    ...(result.terminationReason === 'cancelled' ? { aborted: true } : {}),
    ...(result.sandboxFailure ? { sandboxFailure: result.sandboxFailure } : {}),
    ...(result.processCleanup ? { processCleanup: result.processCleanup } : {}),
    executionPhase,
  });
}
