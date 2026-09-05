import { Box, Text } from 'ink';
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

  if (!running) return null;

  const cancelling = runStatus?.verb === 'Cancelling';
  const retrying = !cancelling && Boolean(runStatus?.retry);
  const color = cancelling || retrying ? t.warning : t.primary;
  const verb = cancelling ? 'Cancelling' : retrying ? 'Retrying' : 'Working';

  return (
    <Box>
      <Text color={color}>⋄ </Text>
      <Text color={color}>{verb}</Text>
    </Box>
  );
}
