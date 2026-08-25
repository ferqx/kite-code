import type { ContextCompactionProgressPhase } from '@kite-ai/runtime-contract';
import { Box, Text } from 'ink';
import { useTheme } from '../theme';
import { useBlinkDot } from './use-blink-dot';

const LABELS: Record<ContextCompactionProgressPhase, string> = {
  preparing: 'Preparing context',
  summarizing: 'Summarizing context',
  validating: 'Validating context',
};

export default function CompactionProgress({ phase }: { phase: ContextCompactionProgressPhase }) {
  const theme = useTheme();
  const frame = useBlinkDot(true);

  return (
    <Box>
      <Text color={theme.dim}>{'  ⎿  '}</Text>
      <Text color={theme.primary}>
        {frame} {LABELS[phase]}
      </Text>
    </Box>
  );
}
