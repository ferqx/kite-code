import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useInkI18n, useInkTheme } from '../../presentation';
import FirstRunShell from './FirstRunShell';
export default function WorkspaceTrustGate({
  path,
  readScopes,
  onTrust,
  onExit,
}: {
  path: string;
  readScopes: readonly { kind: string; description: string }[];
  onTrust(): void;
  onExit(): void;
}) {
  const [choice, setChoice] = useState<'trust' | 'decline'>('decline');
  const theme = useInkTheme(),
    { t } = useInkI18n();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onExit();
    if (key.upArrow || key.downArrow)
      setChoice((value) => (value === 'trust' ? 'decline' : 'trust'));
    else if (key.return) {
      if (choice === 'trust') onTrust();
      else onExit();
    }
  });
  return (
    <FirstRunShell footer={t('firstRun.navigateConfirmExit')}>
      <Text color={theme.muted}>{t('trust.openWorkspace')}</Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>{path}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>{t('trust.providesConfiguration')}</Text>
      </Box>
      <Text color={theme.muted}>{t('trust.approvalSettings')}</Text>
      {readScopes.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text>{t('trust.externalReadScope')}</Text>
          {readScopes.map((scope, index) => (
            <Text key={index} color={theme.dim}>
              {scope.description}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={choice === 'trust' ? theme.primary : theme.muted}>
          {choice === 'trust' ? '›' : ' '} {t('trust.accept')}
        </Text>
        <Text color={choice === 'decline' ? theme.primary : theme.muted}>
          {choice === 'decline' ? '›' : ' '} {t('trust.exit')}
        </Text>
      </Box>
    </FirstRunShell>
  );
}
