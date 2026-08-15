import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { workspaceTrustPath } from '@/core/config/paths';
import { trustWorkspace } from '@/core/config/workspace-trust';
import { useI18n } from '../i18n';
import { useTheme } from '../theme';

interface WorkspaceTrustGateProps {
  workspace: string;
  onTrusted: () => void;
}

type TrustChoice = 'trust' | 'decline';
type TrustStatus = 'idle' | 'saving' | 'error';

export default function WorkspaceTrustGate({ workspace, onTrusted }: WorkspaceTrustGateProps) {
  const t = useTheme();
  const { t: translate } = useI18n();
  const { exit } = useApp();
  // Default focus on "Exit Kite Code" — prevents accidental Enter → trust
  const [choice, setChoice] = useState<TrustChoice>('decline');
  const [status, setStatus] = useState<TrustStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setChoice((current) => (current === 'trust' ? 'decline' : 'trust'));
      setErrorMessage(null);
      if (status === 'error') setStatus('idle');
      return;
    }
    if (key.return) {
      if (choice === 'decline' || status === 'saving') {
        if (choice === 'decline') exit();
        return;
      }
      setStatus('saving');
      setErrorMessage(null);
      const result = trustWorkspace({ workspace, source: 'user' });
      if (result.status === 'recorded') {
        onTrusted();
      } else {
        const store = workspaceTrustPath();
        if (result.status === 'store_unavailable') {
          setErrorMessage(translate('trust.storeUnavailable', { path: store }));
        } else {
          setErrorMessage(translate('trust.storeMalformed', { path: store }));
        }
        setStatus('error');
      }
      return;
    }
  });

  if (status === 'saving') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color={t.primary}>Kite Code</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.saving')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
      </Box>
    );
  }

  const isError = status === 'error';

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column">
        <Text color={t.primary}>Kite Code</Text>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.openWorkspace')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.providesConfiguration')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>{translate('trust.approvalSettings')}</Text>
        </Box>
        {isError && errorMessage ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={t.error}>{translate('trust.saveFailed')}</Text>
            <Box marginTop={1}>
              <Text color={t.muted}>{errorMessage}</Text>
            </Box>
          </Box>
        ) : null}
        {isError && !errorMessage ? (
          <Box marginTop={1}>
            <Text color={t.error}>{translate('trust.needsAttention')}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={choice === 'trust' ? t.primary : t.muted}>
              {choice === 'trust' ? '\u203A' : ' '} {translate('trust.accept')}
            </Text>
          </Box>
          <Box>
            <Text color={choice === 'decline' ? t.primary : t.muted}>
              {choice === 'decline' ? '\u203A' : ' '} {translate('trust.exit')}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>
            {'\u2191\u2193'} {translate('common.navigate')} Enter {translate('common.confirm')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
