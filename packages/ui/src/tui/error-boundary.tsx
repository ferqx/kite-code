import { Box, Text, useInput } from 'ink';
import { Component, type ReactNode } from 'react';
import { terminalText } from './controller';

interface ErrorBoundaryProps {
  children: ReactNode;
  onExit(): void;
  onError?(): void;
  testDiagnostics?: boolean;
}
function ErrorFallback({
  error,
  onExit,
  testDiagnostics,
}: {
  error: Error;
  onExit(): void;
  testDiagnostics?: boolean;
}) {
  useInput((_input, key) => {
    if (key.return || key.escape) onExit();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="red">
        An unrecoverable error occurred
      </Text>
      <Box marginTop={1} paddingLeft={2} borderStyle="single" borderColor="red">
        <Text color="red">{terminalText(error.message)}</Text>
      </Box>
      {testDiagnostics && error.stack && <Text dimColor>{terminalText(error.stack)}</Text>}
      <Box marginTop={1}>
        <Text color="yellow">Press Enter or Esc to exit</Text>
      </Box>
    </Box>
  );
}
/** The host owns exit, draft persistence and Service cleanup; rendering never exits the process. */
export class TuiErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error('tui_render_failed') };
  }
  override componentDidCatch() {
    this.props.onError?.();
  }
  override render() {
    return this.state.error ? (
      <ErrorFallback
        error={this.state.error}
        onExit={this.props.onExit}
        testDiagnostics={this.props.testDiagnostics}
      />
    ) : (
      this.props.children
    );
  }
}
