/**
 * Unified activity-dot adapter. Runtime events own repaint cadence; keeping
 * the glyph static prevents idle agent work from continuously writing stdout
 * and forcing a native terminal viewport back to the bottom.
 *
 * @param active  Whether the activity dot should be visible
 * @returns       Static frame string: '● ' or '  '
 */
export function activityDot(active: boolean): string {
  return active ? '● ' : '  ';
}
