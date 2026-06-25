import { Box, Text } from 'ink';
import { useTheme } from './theme';

type CatMood = 'working' | 'error' | 'idle';

function catMood(running: boolean, error: boolean): CatMood {
  if (running) return 'working';
  if (error) return 'error';
  return 'idle';
}

const CAT_LINES: Record<CatMood, [string, string, string]> = {
  working: ['  /\\_/\\  ', ' ( ^ ^ ) ', '  > w <  '],
  error: ['  /\\_/\\  ', ' ( T T ) ', '  > . <  '],
  idle: ['  /\\_/\\  ', ' ( = = ) ', '  > ~ <  '],
};

interface HeaderProps {
  running: boolean;
  error?: boolean;
}

export default function Header({ running, error }: HeaderProps) {
  const t = useTheme();
  const mood = catMood(running, !!error);
  const [catTop, catMid, catBot] = CAT_LINES[mood];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.primary}>{catTop} </Text>
        <Text bold color={t.primary}>
          Kite Code
        </Text>
      </Box>
      <Box>
        <Text color={t.primary}>{catMid} </Text>
        <Text color={t.dim}>/help shortcuts · Ctrl+C exit</Text>
      </Box>
      <Box>
        <Text color={t.primary}>{catBot} </Text>
        <Text color={t.dim}>/ commands</Text>
      </Box>
    </Box>
  );
}
