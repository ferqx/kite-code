import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { trustWorkspace } from '@/core/config/workspace-trust';
import { useTheme } from '../theme';

interface WorkspaceTrustGateProps {
  /** Absolute workspace path shown to the user / 展示给用户的绝对路径 */
  workspace: string;
  /** Called after the trust record is persisted / 信任记录持久化后调用 */
  onTrusted: () => void;
}

type TrustChoice = 'trust' | 'decline';

/**
 * Workspace authorization prompt shown when opening an untrusted folder for the
 * first time — the VS Code "Do you trust the authors…" gate. Mounted by
 * TuiBootstrap before SetupWizard/TuiApp, so no session, MCP, skill or model
 * side effect happens until the user decides.
 *
 * 首次打开未信任目录时的 workspace 授权确认（类似 VS Code 打开新项目的确认逻辑）。
 * 由 TuiBootstrap 在 SetupWizard/TuiApp 之前挂载，用户决定前不产生任何副作用。
 */
export default function WorkspaceTrustGate({ workspace, onTrusted }: WorkspaceTrustGateProps) {
  const t = useTheme();
  const { exit } = useApp();
  const [choice, setChoice] = useState<TrustChoice>('trust');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      // Ink's exit() unmounts first, restoring cursor/keyboard terminal state.
      exit();
      return;
    }
    if (key.escape) {
      // Declining leaves no persisted state — same as choosing "No, exit".
      exit();
      return;
    }
    if (key.upArrow || key.downArrow) {
      setChoice((current) => (current === 'trust' ? 'decline' : 'trust'));
      return;
    }
    if (key.return) {
      if (choice === 'decline') {
        exit();
        return;
      }
      const result = trustWorkspace({ workspace, source: 'user' });
      if (result.status === 'recorded') {
        onTrusted();
      } else {
        // Persisting failed — stay on the gate so the user can retry or exit.
        setError(result.message);
      }
    }
  });

  const item = (id: TrustChoice, label: string) => (
    <Box>
      <Text color={choice === id ? t.primary : t.muted}>
        {choice === id ? '❯' : ' '} {label}
      </Text>
    </Box>
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.primary}
        paddingX={2}
        paddingY={1}
      >
        <Text bold color={t.primary}>
          Do you trust the authors of the files in this folder?
        </Text>
        <Box marginTop={1}>
          <Text bold>{workspace}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={t.muted}>
            Kite Code will load this project&apos;s configuration, skills and MCP servers,
          </Text>
          <Text color={t.muted}>
            and the agent may execute shell commands and modify files inside it.
          </Text>
          <Text color={t.muted}>Only trust folders you have reviewed yourself.</Text>
        </Box>
        {error ? (
          <Box marginTop={1}>
            <Text color={t.error}>{error}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {item('trust', 'Yes, I trust the authors')}
          {item('decline', 'No, exit')}
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>↑↓ select Enter confirm Esc exit</Text>
        </Box>
      </Box>
    </Box>
  );
}
