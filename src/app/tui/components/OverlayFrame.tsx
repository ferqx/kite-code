import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '@/app/tui/theme';

export interface OverlayShortcut {
  keys: string;
  label: string;
}

export function OverlayShortcutBar({ shortcuts }: { shortcuts: readonly OverlayShortcut[] }) {
  const t = useTheme();
  return (
    <Box gap={2} flexWrap="wrap">
      {shortcuts.map((shortcut) => (
        <Box key={`${shortcut.keys}:${shortcut.label}`}>
          {shortcut.keys && <Text color={t.dim}>{shortcut.keys}</Text>}
          <Text color={t.dim}>
            {shortcut.keys ? ' ' : ''}
            {shortcut.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function OverlayStatusColumn({
  active,
  label = '当前',
  width = 6,
}: {
  active: boolean;
  label?: string;
  width?: number;
}) {
  const t = useTheme();
  return (
    <Box width={width} justifyContent="flex-end" flexShrink={0}>
      {active && (
        <Text bold color={t.success}>
          {label}
        </Text>
      )}
    </Box>
  );
}

interface OverlayFrameProps {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  message?: ReactNode;
  footer?: ReactNode;
}

export default function OverlayFrame({
  title,
  meta,
  children,
  message,
  footer,
}: OverlayFrameProps) {
  const t = useTheme();
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box width="100%" alignItems="center">
        <Text color={t.dim}>── </Text>
        <Text bold color={t.primary}>
          {title}
        </Text>
        <Text color={t.dim}> </Text>
        <Box
          flexGrow={1}
          flexShrink={1}
          minWidth={1}
          height={1}
          borderStyle="single"
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={t.dim}
        />
        {meta && (
          <>
            <Text color={t.dim}> </Text>
            {typeof meta === 'string' || typeof meta === 'number' ? (
              <Text color={t.dim}>{meta}</Text>
            ) : (
              meta
            )}
            <Text color={t.dim}> ──</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
        {message && <Box marginTop={1}>{message}</Box>}
        {footer && (
          <Box
            marginTop={1}
            borderStyle="single"
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor={t.dim}
          >
            {footer}
          </Box>
        )}
      </Box>
    </Box>
  );
}
