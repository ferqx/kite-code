import { PasswordInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useRef } from 'react';
import { useI18n } from '../../i18n';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';

interface ApiKeyFormProps {
  providerLabel: string;
  apiKey: string;
  error?: string;
  onUpdate: (value: string) => void;
  onSubmit: (value: string) => void;
  onBack: () => void;
}

export function ApiKeyForm({ providerLabel, error, onUpdate, onSubmit, onBack }: ApiKeyFormProps) {
  const t = useTheme();
  const { t: translate } = useI18n();

  // Stable refs to prevent PasswordInput's internal useEffect from looping
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const stableOnChange = useCallback((v: string) => onUpdateRef.current(v), []);
  const stableOnSubmit = useCallback((v: string) => onSubmitRef.current(v), []);

  // Only handle Esc — PasswordInput handles characters, backspace, Enter internally
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  return (
    <FirstRunShell
      title={translate('firstRun.connectTo', { provider: providerLabel })}
      step={translate('firstRun.setupStep', { current: 2, total: 2 })}
      footer={translate('firstRun.connectBack')}
    >
      <Text color={t.dim}>{translate('firstRun.enterApiKey', { provider: providerLabel })}</Text>
      {error ? (
        <Box marginTop={1}>
          <Text color={t.error}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={t.muted}>{translate('firstRun.apiKey')}</Text>
        </Box>
        <Box>
          <Text color={t.primary}>{'\u203A'} </Text>
          <PasswordInput placeholder="sk-..." onChange={stableOnChange} onSubmit={stableOnSubmit} />
        </Box>
      </Box>
    </FirstRunShell>
  );
}
