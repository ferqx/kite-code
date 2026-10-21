/** Only handles produced by this fixture's own spawn are accepted for signals. */
export function spawnOwnedStage(script: string, phase: string, root: string) {
  return Bun.spawn([process.execPath, ...process.execArgv, script, phase, root], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env },
  });
}
export type OwnedStage = ReturnType<typeof spawnOwnedStage>;
export async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('owned_stage_deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function firstOwnedLine(
  child: OwnedStage,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const reader = child.stdout.getReader();
  let text = '';
  try {
    return await bounded(
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw Error('owned_stage_exited_before_boundary');
          text += new TextDecoder().decode(chunk.value);
          if (text.length > 64 * 1024) throw Error('owned_stage_boundary_oversize');
          const at = text.indexOf('\n');
          if (at >= 0) return JSON.parse(text.slice(0, at)) as Record<string, unknown>;
        }
      })(),
      timeoutMs,
    );
  } finally {
    reader.releaseLock();
  }
}
export async function killOwnedStage(child: OwnedStage) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw Error('owned_stage_already_exited');
  const pid = child.pid;
  child.kill('SIGKILL');
  const exitCode = await bounded(child.exited, 10000);
  if (child.signalCode !== 'SIGKILL') throw Error('owned_stage_signal_not_observed');
  return { pid, exitCode, signal: child.signalCode };
}
