import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useInkTheme as useTheme } from '../presentation';

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
  width = 8,
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
  contentPaddingX?: number;
  title: ReactNode;
  hint?: string;
  meta?: ReactNode;
  children: ReactNode;
  message?: ReactNode;
  footer?: ReactNode;
}

export default function OverlayFrame({
  contentPaddingX = 1,
  title,
  meta,
  hint,
  children,
  message,
  footer,
}: OverlayFrameProps) {
  const t = useTheme();
  footer ??= hint ? <Text color={t.dim}>{hint}</Text> : undefined;
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
      <Box flexDirection="column" paddingX={contentPaddingX}>
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
