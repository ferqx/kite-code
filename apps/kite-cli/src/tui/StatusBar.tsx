import { Box, Text } from 'ink';
import { useRef } from 'react';
import { useActivityClock } from './components/use-activity-clock';
import type { RunStatusSnapshot } from './run-status';
import { useTheme } from './theme';

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface StatusBarProps {
  runStatus?: RunStatusSnapshot;
  running: boolean;
}

export default function StatusBar({ runStatus, running }: StatusBarProps) {
  const t = useTheme();

  const now = useActivityClock(running);
  const baseline = useRef({
    elapsed: runStatus?.elapsedMs,
    startedAt: Date.now() - (runStatus?.elapsedMs ?? 0),
    running,
  });
  if (baseline.current.elapsed !== runStatus?.elapsedMs || baseline.current.running !== running) {
    baseline.current = {
      elapsed: runStatus?.elapsedMs,
      startedAt: Date.now() - (runStatus?.elapsedMs ?? 0),
      running,
    };
  }
  if (!running) return null;
  const elapsed = Math.max(0, Math.floor((now - baseline.current.startedAt) / 1000));
  const frame = ['·', '⋄', '⋆', '✧'][Math.floor(now / 250) % 4];

  const cancelling = runStatus?.verb === 'Cancelling';
  const retrying = !cancelling && Boolean(runStatus?.retry);
  const color = cancelling || retrying ? t.warning : t.primary;
  const verb = cancelling ? 'Cancelling' : retrying ? 'Retrying' : 'Working';

  return (
    <Box>
      <Text color={color}>{frame} </Text>
      <Text color={color}>
        {verb} · {formatDuration(elapsed)}
      </Text>
    </Box>
  );
}
