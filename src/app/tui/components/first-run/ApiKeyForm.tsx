import { PasswordInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useRef } from 'react';
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
      title={`Connect to ${providerLabel}`}
      step="Setup 2 of 2"
      footer="Enter Connect   Esc Back"
    >
      <Text color={t.dim}>Enter your {providerLabel} API key.</Text>
      {error ? (
        <Box marginTop={1}>
          <Text color={t.error}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={t.muted}>API key</Text>
        </Box>
        <Box>
          <Text color={t.primary}>{'\u203A'} </Text>
          <PasswordInput placeholder="sk-..." onChange={stableOnChange} onSubmit={stableOnSubmit} />
        </Box>
      </Box>
    </FirstRunShell>
  );
}
