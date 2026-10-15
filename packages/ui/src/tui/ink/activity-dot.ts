/** Fixed-width activity frames; terminal output is owned by Ink. */
export function activityDot(active: boolean, now: number | null = 0): string {
  if (active && now === null) return '? ';
  return active && Math.floor((now ?? 0) / 1_000) % 2 === 0 ? '● ' : '  ';
}
