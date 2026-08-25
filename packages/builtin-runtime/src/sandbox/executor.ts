export function resolveSandboxExitCode(
  exitCode: number,
  state: { timedOut: boolean; cancelled: boolean; processCleanupConfirmed: boolean },
): number {
  if (state.timedOut) return 124;
  if (state.cancelled) return 130;
  if (!state.processCleanupConfirmed) return -1;
  return exitCode;
}
