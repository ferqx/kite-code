import { Box, Text, useInput } from 'ink';
import React from 'react';
import {
  resolveWindowsManagedNetworkSetupStatusV1,
  setupWindowsManagedNetworkV1,
  windowsManagedNetworkStatusAllowsEntryV1,
} from '@/core/sandbox/windows-network-setup';
import { useTheme } from '../../theme';
import FirstRunShell from './FirstRunShell';

interface WindowsSandboxSetupGateProps {
  onComplete: () => void;
  onExit: () => void;
}

type ViewState =
  | { kind: 'checking' }
  | { kind: 'needs-setup'; detail?: string }
  | { kind: 'setting-up' }
  | { kind: 'error'; detail: string };

export default function WindowsSandboxSetupGate({
  onComplete,
  onExit,
}: WindowsSandboxSetupGateProps) {
  const t = useTheme();
  const [view, setView] = React.useState<ViewState>({ kind: 'checking' });
  const [choice, setChoice] = React.useState<'setup' | 'exit'>('setup');
  // Until the first status resolution completes the gate renders nothing: a
  // ready installation must not flash the setup screen between the cleared
  // terminal and the main UI.
  const [pendingInitialCheck, setPendingInitialCheck] = React.useState(true);

  const check = React.useCallback(async () => {
    setView({ kind: 'checking' });
    try {
      const status = await resolveWindowsManagedNetworkSetupStatusV1();
      if (windowsManagedNetworkStatusAllowsEntryV1(status)) {
        onComplete();
        return;
      }
      setPendingInitialCheck(false);
      setView({
        kind: 'needs-setup',
        detail: status.state === 'missing' ? undefined : status.reason,
      });
    } catch (error) {
      setPendingInitialCheck(false);
      setView({ kind: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }, [onComplete]);

  React.useEffect(() => {
    void check();
  }, [check]);

  // Confirm-time re-check: concurrent TUI instances share this one-time
  // setup, and another instance may complete it while the user is choosing.
  // Absorb that silently instead of launching a redundant elevated install.
  const confirm = React.useCallback(async () => {
    setView({ kind: 'checking' });
    try {
      const status = await resolveWindowsManagedNetworkSetupStatusV1();
      if (windowsManagedNetworkStatusAllowsEntryV1(status)) {
        onComplete();
        return;
      }
      setView({ kind: 'setting-up' });
      await setupWindowsManagedNetworkV1();
      onComplete();
    } catch (error) {
      setView({ kind: 'error', detail: error instanceof Error ? error.message : String(error) });
    }
  }, [onComplete]);

  useInput((input, key) => {
    if (view.kind === 'checking' || view.kind === 'setting-up') return;
    if (key.escape || (key.ctrl && input === 'c')) {
      onExit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setChoice((current) => (current === 'setup' ? 'exit' : 'setup'));
      return;
    }
    if (!key.return) return;
    if (choice === 'exit') {
      onExit();
    } else {
      void confirm();
    }
  });

  if (pendingInitialCheck) return null;

  const busy = view.kind === 'checking' || view.kind === 'setting-up';
  const setupLabel = view.kind === 'error' ? 'Try again' : 'Set up default sandbox';
  return (
    <FirstRunShell
      title="Windows sandbox setup"
      footer={busy ? 'Please wait' : '↑↓ Navigate   Enter Confirm   Esc Exit'}
    >
      <Box flexDirection="column">
        <Text color={t.muted}>
          Kite Code uses a dedicated local identity for approved network commands.
        </Text>
        <Text color={t.dim}>
          Setup runs once and requires Administrator permission. Shell commands never create the
          identity themselves.
        </Text>
        {view.kind === 'checking' ? (
          <Box marginTop={1}>
            <Text color={t.muted}>Checking sandbox setup…</Text>
          </Box>
        ) : null}
        {view.kind === 'setting-up' ? (
          <Box marginTop={1}>
            <Text color={t.muted}>Setting up sandbox… Confirm the Windows permission prompt.</Text>
          </Box>
        ) : null}
        {view.kind === 'error' || (view.kind === 'needs-setup' && view.detail) ? (
          <Box marginTop={1}>
            <Text color={t.error}>{view.kind === 'error' ? view.detail : view.detail}</Text>
          </Box>
        ) : null}
        {!busy ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={choice === 'setup' ? t.primary : t.muted}>
              {choice === 'setup' ? '›' : ' '} {setupLabel} (requires Administrator permissions)
            </Text>
            <Text color={choice === 'exit' ? t.primary : t.muted}>
              {choice === 'exit' ? '›' : ' '} Exit Kite Code
            </Text>
          </Box>
        ) : null}
      </Box>
    </FirstRunShell>
  );
}
