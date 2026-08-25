export function shouldSetIdleAfterRun(
  stillActive: boolean,
  runGeneration: number,
  latestGeneration: number,
): boolean {
  return stillActive && runGeneration === latestGeneration;
}

export function shouldAbortStoppedRun(input: {
  wasRunning: boolean;
  running: boolean;
  ctrlCPressed: boolean;
  exited: boolean;
}): boolean {
  // A normal runtime completion sets `exited` before the async runTask
  // finalizer dispatches SET_IDLE. Do not abort that already-completed run.
  // Only a user-visible stop without a terminal exit needs the fallback abort.
  return input.wasRunning && !input.running && !input.ctrlCPressed && !input.exited;
}

export function shouldProjectRunExited(input: {
  aborted: boolean;
  signalAborted: boolean;
  foreground: boolean;
}): boolean {
  // A generator may close normally after its AbortSignal fires without yielding
  // a final event or throwing. The signal remains the authoritative per-run
  // cancellation fact and must suppress the predecessor's terminal projection.
  return input.foreground && !input.aborted && !input.signalAborted;
}
