import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '#kite-cli/tui/theme';

export function OverlaySection({
  children,
  first = false,
}: {
  children: ReactNode;
  first?: boolean;
}) {
  const t = useTheme();
  return (
    <Box
      marginTop={first ? 0 : 1}
      marginBottom={1}
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderBottom
      borderColor={t.dim}
    >
      <Text bold color={t.muted}>
        {children}
      </Text>
    </Box>
  );
}

export function OverlaySummary({ left, right }: { left: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <Box width="100%" paddingX={1} marginBottom={1} justifyContent="space-between">
      <Text color={t.muted}>{left}</Text>
      {right && <Text color={t.dim}>{right}</Text>}
    </Box>
  );
}

export function OverlayList({ children }: { children: ReactNode }) {
  return <Box flexDirection="column">{children}</Box>;
}

export function OverlayListRow({
  selected = false,
  disabled = false,
  destructive = false,
  primary,
  content,
  secondary,
  trailing,
  indicator,
  selectionBackground = true,
  primaryColor,
}: {
  selected?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  primary?: ReactNode;
  content?: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  indicator?: ReactNode;
  selectionBackground?: boolean;
  primaryColor?: string;
}) {
  const t = useTheme();
  const color = disabled ? t.dim : destructive ? t.error : selected ? t.primary : t.muted;
  return (
    <Box
      width="100%"
      paddingX={1}
      flexDirection="column"
      backgroundColor={selected && selectionBackground ? t.userMsgBg : undefined}
    >
      <Box width="100%">
        <Box width={2} flexShrink={0}>
          {indicator ?? (
            <Text bold color={selected ? t.primary : t.dim}>
              {selected ? '❯ ' : '  '}
            </Text>
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {content ?? (
            <Text bold={selected} color={primaryColor ?? color} wrap="truncate-end">
              {primary}
            </Text>
          )}
        </Box>
        {trailing && (
          <Box flexShrink={0} marginLeft={1}>
            {trailing}
          </Box>
        )}
      </Box>
      {secondary && (
        <Box paddingLeft={2} paddingRight={1}>
          <Text color={t.dim} wrap="truncate-end">
            {secondary}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export interface OverlayDetailItem {
  label: ReactNode;
  value: ReactNode;
  valueColor?: string;
  truncate?: boolean;
}

export function OverlayDetailList({
  items,
  labelWidth = 18,
}: {
  items: readonly OverlayDetailItem[];
  labelWidth?: number;
}) {
  const t = useTheme();
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((item, index) => (
        <Box key={index} width="100%">
          <Box width={labelWidth} flexShrink={0}>
            <Text color={t.dim}>{item.label}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={item.valueColor} wrap={item.truncate ? 'truncate-end' : 'wrap'}>
              {item.value}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export function OverlayMessage({
  children,
  tone = 'info',
  callout = false,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'error' | 'busy';
  callout?: boolean;
}) {
  const t = useTheme();
  const color =
    tone === 'error' ? t.error : tone === 'warning' || tone === 'busy' ? t.warning : t.muted;
  if (!callout) return <Text color={color}>{children}</Text>;
  return (
    <Box
      paddingLeft={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft
      borderColor={color}
    >
      <Text color={color}>{children}</Text>
    </Box>
  );
}

export function OverlayImpactNotice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning';
}) {
  return (
    <Box marginTop={1} paddingX={1}>
      <OverlayMessage tone={tone} callout>
        {children}
      </OverlayMessage>
    </Box>
  );
}

export function OverlayEmptyState({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text color={t.muted}>{children}</Text>;
}
