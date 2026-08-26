import { Box, Text, useInput } from 'ink';
import React from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';

interface ConfigErrorScreenProps {
  configPath: string;
  message: string;
  onRetry: () => void;
  onExit?: () => void;
}

export default function ConfigErrorScreen({
  configPath,
  message,
  onRetry,
  onExit = () => undefined,
}: ConfigErrorScreenProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const [choice, setChoice] = React.useState<'retry' | 'exit'>('retry');

  useInput((_input, key) => {
    if (key.escape || (key.ctrl && _input === 'c')) {
      onExit();
      return;
    }
    if ((key.upArrow || key.downArrow) && !key.return) {
      setChoice((c) => (c === 'retry' ? 'exit' : 'retry'));
      return;
    }
    if (key.return) {
      if (choice === 'exit') {
        onExit();
      } else {
        onRetry();
      }
      return;
    }
  });

  return (
    <FirstRunShell footer={translate('firstRun.navigateConfirmExit')}>
      <Box flexDirection="column">
        <Text color={t.error}>{translate('firstRun.configLoadFailed')}</Text>
        <Box marginTop={1}>
          <Text color={t.dim}>{configPath}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{message}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('firstRun.fixFile')}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={choice === 'retry' ? t.primary : t.muted}>
              {choice === 'retry' ? '\u203A' : ' '} {translate('firstRun.tryAgain')}
            </Text>
          </Box>
          <Box>
            <Text color={choice === 'exit' ? t.primary : t.muted}>
              {choice === 'exit' ? '\u203A' : ' '} {translate('trust.exit')}
            </Text>
          </Box>
        </Box>
      </Box>
    </FirstRunShell>
  );
}
