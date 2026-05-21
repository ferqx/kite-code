import React, { Component } from "react";
import { Box, Text, useInput } from "ink";
import { darkTheme } from "../theme";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function ErrorFallback({ error }: { error: Error }) {
  useInput(() => {
    process.exit(1);
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
        <Text color={darkTheme.warning}>Press any key to exit</Text>
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

  componentDidCatch(error: Error, _info: React.ErrorInfo): void {
    // Log the error so it appears in stderr even if TUI is broken
    console.error("[ErrorBoundary] Caught render error:", error);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} />;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
