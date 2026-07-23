import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import type { ContextCompactionProgressPhase } from '@/core/model/context-compaction-presentation';
import { useTheme } from '../theme';

const FRAMES = ['●···', '·●··', '··●·', '···●', '··●·', '·●··'];

const LABELS: Record<ContextCompactionProgressPhase, string> = {
  preparing: 'Preparing context',
  summarizing: 'Summarizing context',
  validating: 'Validating context',
};

export default function CompactionProgress({ phase }: { phase: ContextCompactionProgressPhase }) {
  const theme = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box>
      <Text color={theme.dim}>{'  ⎿  '}</Text>
      <Text color={theme.primary}>
        {FRAMES[frame]} {LABELS[phase]}
      </Text>
    </Box>
  );
}
