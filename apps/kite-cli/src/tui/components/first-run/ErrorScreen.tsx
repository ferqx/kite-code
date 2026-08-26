import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';
import type { ConnectionError, ProviderDefinition } from './types';
import { getErrorActions } from './types';

interface ErrorScreenProps {
  provider: ProviderDefinition;
  error: ConnectionError;
  selectedAction: number;
  onSelectAction: (index: number) => void;
  onConfirmAction: (action: number) => void;
  onBack: () => void;
}

export default function ErrorScreen({
  provider,
  error,
  selectedAction,
  onSelectAction,
  onConfirmAction,
  onBack,
}: ErrorScreenProps) {
  const t = useTheme();
  const actions = getErrorActions(error);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      onSelectAction(Math.max(0, selectedAction - 1));
      return;
    }
    if (key.downArrow) {
      onSelectAction(Math.min(actions.length - 1, selectedAction + 1));
      return;
    }
    if (key.return) {
      onConfirmAction(selectedAction);
      return;
    }
  });

  let title: string;
  let detail: string;
  switch (error.kind) {
    case 'auth':
      title = `Could not connect to ${provider.label}`;
      detail = error.details ?? 'Check that the key is active and copied completely.';
      break;
    case 'unreachable':
      title = 'Could not reach the endpoint';
      detail = `${error.details ?? ''}\nCheck that the service is running and that the address is correct.`;
      break;
    case 'incompatible':
      title = 'The endpoint is reachable';
      detail =
        'Kite Code could not read its model list.\nYou can continue by entering the model name manually.';
      break;
    default:
      title = `Could not connect to ${provider.label}`;
      detail = error.message;
  }

  return (
    <FirstRunShell footer="↑↓ Navigate   Enter Confirm   Esc Back">
      <Box flexDirection="column">
        <Text color={t.error}>{title}</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{detail}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {actions.map((a, i) => (
            <Box key={a.action}>
              <Text color={i === selectedAction ? t.primary : t.muted}>
                {i === selectedAction ? '\u203A' : ' '} {a.label}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    </FirstRunShell>
  );
}
