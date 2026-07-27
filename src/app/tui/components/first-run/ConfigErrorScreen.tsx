import { Box, Text, useApp, useInput } from 'ink';
import React from 'react';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';

interface ConfigErrorScreenProps {
  configPath: string;
  message: string;
  onRetry: () => void;
}

export default function ConfigErrorScreen({
  configPath,
  message,
  onRetry,
}: ConfigErrorScreenProps) {
  const t = useTheme();
  const { exit } = useApp();
  const [choice, setChoice] = React.useState<'retry' | 'exit'>('retry');

  useInput((_input, key) => {
    if (key.escape || (key.ctrl && _input === 'c')) {
      exit();
      return;
    }
    if ((key.upArrow || key.downArrow) && !key.return) {
      setChoice((c) => (c === 'retry' ? 'exit' : 'retry'));
      return;
    }
    if (key.return) {
      if (choice === 'exit') {
        exit();
      } else {
        onRetry();
      }
      return;
    }
  });

  return (
    <FirstRunShell footer="\u2191\u2193 Navigate   Enter Confirm   Esc Exit">
      <Box flexDirection="column">
        <Text color={t.error}>Configuration could not be loaded</Text>
        <Box marginTop={1}>
          <Text color={t.dim}>{configPath}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>Fix the file and try again.</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={choice === 'retry' ? t.primary : t.muted}>
              {choice === 'retry' ? '\u203A' : ' '} Try again
            </Text>
          </Box>
          <Box>
            <Text color={choice === 'exit' ? t.primary : t.muted}>
              {choice === 'exit' ? '\u203A' : ' '} Exit Kite Code
            </Text>
          </Box>
        </Box>
      </Box>
    </FirstRunShell>
  );
}
