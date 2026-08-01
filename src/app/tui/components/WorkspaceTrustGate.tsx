import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { workspaceTrustPath } from '@/core/config/paths';
import { trustWorkspace } from '@/core/config/workspace-trust';
import { useTheme } from '../theme';

interface WorkspaceTrustGateProps {
  workspace: string;
  onTrusted: () => void;
}

type TrustChoice = 'trust' | 'decline';
type TrustStatus = 'idle' | 'saving' | 'error';

export default function WorkspaceTrustGate({ workspace, onTrusted }: WorkspaceTrustGateProps) {
  const t = useTheme();
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
          setErrorMessage(`The trust store is unavailable:\n${store}`);
        } else {
          setErrorMessage(
            `The following file is malformed:\n${store}\nFix or remove the file, then try again.`,
          );
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
          <Text color={t.muted}>Saving workspace trust…</Text>
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
          <Text color={t.muted}>Open this workspace?</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{workspace}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={t.muted}>This workspace may provide local configuration, skills,</Text>
          <Text color={t.muted}>and MCP servers.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={t.muted}>Kite Code may run commands and modify files according to</Text>
        </Box>
        <Box>
          <Text color={t.muted}>your current approval settings.</Text>
        </Box>
        {isError && errorMessage ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={t.error}>Workspace trust could not be saved</Text>
            <Box marginTop={1}>
              <Text color={t.muted}>{errorMessage}</Text>
            </Box>
          </Box>
        ) : null}
        {isError && !errorMessage ? (
          <Box marginTop={1}>
            <Text color={t.error}>Workspace trust needs attention</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={choice === 'trust' ? t.primary : t.muted}>
              {choice === 'trust' ? '\u203A' : ' '} Trust this workspace and continue
            </Text>
          </Box>
          <Box>
            <Text color={choice === 'decline' ? t.primary : t.muted}>
              {choice === 'decline' ? '\u203A' : ' '} Exit Kite Code
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{'\u2191\u2193'} Navigate Enter Confirm</Text>
        </Box>
      </Box>
    </Box>
  );
}
