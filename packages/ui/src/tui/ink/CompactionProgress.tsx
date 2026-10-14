import { Box, Text } from 'ink';
import { useInkTheme } from '../presentation';
import { activityDot } from './activity-dot';
import type { ContextCompactionProgressPhase } from './types';
import { useActivityClock } from './use-activity-clock';

const LABELS: Record<ContextCompactionProgressPhase, string> = {
  preparing: 'Preparing context',
  summarizing: 'Summarizing context',
  validating: 'Validating context',
};

export default function CompactionProgress({ phase }: { phase: ContextCompactionProgressPhase }) {
  const theme = useInkTheme();
  const frame = activityDot(true, useActivityClock(true));

  return (
    <Box>
      <Text color={theme.dim}>{'  ⎿  '}</Text>
      <Text color={theme.primary}>
        {frame} {LABELS[phase]}
      </Text>
    </Box>
  );
}
