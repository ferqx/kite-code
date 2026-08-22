import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { Component } from 'react';
import { darkTheme } from '../theme';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onExit?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export function unrecoverableErrorExitHintV1(error: Error): string {
  if (
    error.name === 'RuntimeInstallationAuthorityKeyErrorV1' &&
    'code' in error &&
    error.code === 'key_unavailable'
  ) {
    return 'Press Enter or Esc to exit · Restore the Runtime authority key before restarting';
  }
  return 'Press Enter or Esc to exit';
}

function ErrorFallback({ error, onExit }: { error: Error; onExit?: () => void }) {
  useInput((_input, key: { escape?: boolean; return?: boolean }) => {
    // Exit on Escape or Return — user explicitly chooses to exit.
    // Not using process.exit(1) on any key because in test environments
    // it would kill the suite.
    if (key.escape || key.return) {
      onExit?.();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color={darkTheme.error}>
          An unrecoverable error occurred
        </Text>
      </Box>
      <Box marginBottom={1} paddingLeft={2} borderStyle="single" borderColor={darkTheme.error}>
        <Text color={darkTheme.error}>{error.message}</Text>
      </Box>
      {error.stack ? (
        <Box marginBottom={1}>
          <Text color={darkTheme.dim}>{error.stack}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={darkTheme.warning}>{unrecoverableErrorExitHintV1(error)}</Text>
      </Box>
    </Box>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onExit={this.props.onExit} />;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
