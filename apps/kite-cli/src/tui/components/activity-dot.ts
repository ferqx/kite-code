/** Fixed-width activity frames; terminal output is owned by Ink. */
export function activityDot(active: boolean, now = 0): string {
  return active && Math.floor(now / 1_000) % 2 === 0 ? '● ' : '  ';
}
