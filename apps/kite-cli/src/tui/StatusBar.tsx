import { Box, Text } from 'ink';
import { useActivityClock } from './components/use-activity-clock';
import type { RunStatusSnapshot } from './run-status';
import { useTheme } from './theme';

interface StatusBarProps {
  runStatus?: RunStatusSnapshot;
  running: boolean;
}

export default function StatusBar({ runStatus, running }: StatusBarProps) {
  const t = useTheme();

  const now = useActivityClock(running);
  if (!running) return null;
  const frame = ['·', '⋄', '⋆', '✧'][Math.floor(now / 250) % 4];

  const cancelling = runStatus?.verb === 'Cancelling';
  const retrying = !cancelling && Boolean(runStatus?.retry);
  const color = cancelling || retrying ? t.warning : t.primary;
  const verb = cancelling ? 'Cancelling' : retrying ? 'Retrying' : 'Working';

  return (
    <Box>
      <Text color={color}>{frame} </Text>
      <Text color={color}>{verb}</Text>
    </Box>
  );
}
