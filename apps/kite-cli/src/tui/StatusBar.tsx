import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { RunStatusSnapshot } from './run-status';
import { useTheme } from './theme';
import type { StatusState } from './types';

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface StatusBarProps {
  status: StatusState;
  runStatus?: RunStatusSnapshot;
  running: boolean;
  timerKey: number;
}

// ── spinner ──
// Variable-duration frames: breathes slower at ★ peak, faster at edges
const SPINNER: [string, number][] = [
  ['·', 150],
  ['⋄', 240],
  ['⋆', 180],
  ['✧', 200],
  ['✦', 240],
  ['✧', 200],
  ['⋆', 180],
  ['⋄', 240],
];

export default function StatusBar({ runStatus, running, timerKey }: StatusBarProps) {
  const t = useTheme();
  const [spinnerIdx, setSpinnerIdx] = useState(0);

  // Reset spinner on mount
  useEffect(() => {
    setSpinnerIdx(0);
  }, []);

  // Single animation timer — depends only on `running`.
  // Tool output re-renders do NOT restart this timer.
  // runStatus?.elapsedMs is intentionally excluded: synced via startedAtRef instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — timer must not restart on prop changes
  useEffect(() => {
    if (!running) {
      setSpinnerIdx(0);
      return;
    }

    // Spinner — recursive setTimeout with per-frame duration
    let spinnerTimer: ReturnType<typeof setTimeout>;
    const scheduleNext = (idx: number) => {
      const [, ms] = SPINNER[idx]!;
      spinnerTimer = setTimeout(() => {
        const next = (idx + 1) % SPINNER.length;
        setSpinnerIdx(next);
        scheduleNext(next);
      }, ms);
    };
    setSpinnerIdx(0);
    scheduleNext(0);

    return () => {
      clearTimeout(spinnerTimer);
    };
  }, [running, timerKey]);

  if (!running) return null;

  const cancelling = runStatus?.verb === 'Cancelling';
  const retrying = !cancelling && Boolean(runStatus?.retry);
  const color = cancelling || retrying ? t.warning : t.primary;
  const verb = cancelling ? 'Cancelling' : retrying ? 'Retrying' : 'Working';

  return (
    <Box>
      <Text color={color}>{SPINNER[spinnerIdx]![0]} </Text>
      <Text color={color}>{verb}</Text>
    </Box>
  );
}
