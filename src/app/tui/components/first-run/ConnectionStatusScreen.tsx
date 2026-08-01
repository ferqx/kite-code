import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';
import type { ProviderDefinition } from './types';

interface ConnectionStatusScreenProps {
  provider: ProviderDefinition;
  stage: 'credentials' | 'models';
  onCancel: () => void;
}

export default function ConnectionStatusScreen({
  provider,
  stage,
  onCancel,
}: ConnectionStatusScreenProps) {
  const t = useTheme();

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <FirstRunShell footer="Esc Cancel">
      <Box flexDirection="column">
        <Text color={t.muted}>Connecting to {provider.label}…</Text>
        {stage === 'credentials' ? (
          <Box marginTop={1}>
            <Text color={t.dim}>Checking credentials</Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color={t.dim}>Finding available models</Text>
          </Box>
        )}
      </Box>
    </FirstRunShell>
  );
}
