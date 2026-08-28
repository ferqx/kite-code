import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../../theme';

interface FirstRunShellProps {
  title?: string;
  step?: string;
  children: ReactNode;
  footer: string;
}

export default function FirstRunShell({ title, step, children, footer }: FirstRunShellProps) {
  const t = useTheme();
  const header = step ? `Kite Code                                     ${step}` : 'Kite Code';

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box flexDirection="column">
        <Text color={t.primary}>{header}</Text>
        {title ? (
          <Box marginTop={1}>
            <Text color={t.muted}>{title}</Text>
          </Box>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
        <Box marginTop={1}>
          <Text color={t.dim}>{footer}</Text>
        </Box>
      </Box>
    </Box>
  );
}
